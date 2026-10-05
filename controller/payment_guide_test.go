package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func TestPaymentGuideDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			var driver gorm.Dialector
			switch dialect {
			case "sqlite":
				driver = sqlite.Open(filepath.Join(t.TempDir(), "guide.db"))
			case "mysql":
				dsn := os.Getenv("TEST_GUIDE_MYSQL_DSN")
				if dsn == "" {
					t.Skip("TEST_GUIDE_MYSQL_DSN not configured")
				}
				driver = mysql.Open(dsn)
			case "postgres":
				dsn := os.Getenv("TEST_GUIDE_POSTGRES_DSN")
				if dsn == "" {
					t.Skip("TEST_GUIDE_POSTGRES_DSN not configured")
				}
				driver = postgres.Open(dsn)
			}
			db, err := gorm.Open(driver, &gorm.Config{})
			require.NoError(t, err)
			sqlDB, err := db.DB()
			require.NoError(t, err)
			if dialect == "sqlite" {
				sqlDB.SetMaxOpenConns(1)
			}
			oldDB := model.DB
			model.DB = db
			t.Cleanup(func() {
				model.DB = oldDB
				_ = db.Migrator().DropTable(&model.PaymentGuideProgress{}, &model.TopUp{}, &model.Redemption{})
				_ = sqlDB.Close()
			})
			versionSQL := "SELECT VERSION()"
			if dialect == "sqlite" {
				versionSQL = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, db.Raw(versionSQL).Scan(&version).Error)
			t.Logf("Database version: %s", version)
			for _, upgrade := range []bool{false, true} {
				t.Run(fmt.Sprintf("upgrade=%t", upgrade), func(t *testing.T) {
					require.NoError(t, db.Migrator().DropTable(&model.PaymentGuideProgress{}, &model.TopUp{}, &model.Redemption{}))
					// TopUp and Redemption match the released rc.39.25 models unchanged.
					require.NoError(t, db.AutoMigrate(&model.TopUp{}, &model.Redemption{}))
					topup := model.TopUp{UserId: 20, TradeNo: "paid-before-guide", Status: common.TopUpStatusSuccess, Amount: 5}
					redemption := model.Redemption{UsedUserId: 21, Key: "00000000000000000000000000000021", RedeemedTime: 100, Status: common.RedemptionCodeStatusUsed}
					if !upgrade {
						require.NoError(t, db.AutoMigrate(&model.PaymentGuideProgress{}))
					}
					require.NoError(t, db.Create(&topup).Error)
					require.NoError(t, db.Create(&redemption).Error)
					require.NoError(t, db.Delete(&redemption).Error)
					for range 2 {
						require.NoError(t, db.AutoMigrate(&model.PaymentGuideProgress{}))
					}
					var preserved model.TopUp
					require.NoError(t, db.First(&preserved, topup.Id).Error)
					assert.Equal(t, topup, preserved)
					var oldCode model.Redemption
					require.NoError(t, db.Unscoped().First(&oldCode, redemption.Id).Error)
					assert.Equal(t, redemption.Key, oldCode.Key)
					assert.True(t, oldCode.DeletedAt.Valid)
					for _, id := range []int{20, 21} {
						state, err := model.RecordPaymentGuideView(id)
						require.NoError(t, err)
						assert.False(t, state.ShowGuide)
						assert.Equal(t, 3, state.ShownCount)
					}
					pending := model.TopUp{UserId: 22, TradeNo: "pending", Status: common.TopUpStatusPending}
					require.NoError(t, db.Create(&pending).Error)
					state, err := model.GetPaymentGuideStatus(22)
					require.NoError(t, err)
					assert.True(t, state.ShowGuide)
					// GET never consumes reminders. API uses the authenticated identity only.
					router := gin.New()
					router.Use(func(c *gin.Context) { c.Set("id", 1); c.Next() })
					router.GET("/guide", GetPaymentGuide)
					router.POST("/guide", RecordPaymentGuide)
					for _, expected := range []int{0, 0, 1, 2, 3, 3} {
						method := http.MethodPost
						if expected == 0 {
							method = http.MethodGet
						}
						response := httptest.NewRecorder()
						router.ServeHTTP(response, httptest.NewRequest(method, "/guide?user_id=20", nil))
						var body struct {
							Success bool
							Data    model.PaymentGuideStatus
						}
						require.NoError(t, common.Unmarshal(response.Body.Bytes(), &body))
						require.True(t, body.Success)
						assert.Equal(t, expected, body.Data.ShownCount)
						if expected == 1 {
							// First redemption must not cancel the remaining two reminders.
							require.NoError(t, db.Create(&model.Redemption{UsedUserId: 1, Key: "00000000000000000000000000000001", RedeemedTime: 200, Status: common.RedemptionCodeStatusUsed}).Error)
						}
					}
					state, err = model.GetPaymentGuideStatus(1)
					require.NoError(t, err)
					assert.False(t, state.ShowGuide)
					require.NoError(t, db.AutoMigrate(&model.PaymentGuideProgress{}))
					state, err = model.GetPaymentGuideStatus(1)
					require.NoError(t, err)
					assert.Equal(t, 3, state.ShownCount)
					duplicate := model.PaymentGuideProgress{UserId: 1}
					assert.Error(t, db.Create(&duplicate).Error)
					_, err = model.RecordPaymentGuideView(0)
					assert.Error(t, err)
					// Concurrent devices may consume at most three reminders, with no lost increments.
					results := make(chan model.PaymentGuideStatus, 5)
					failures := make(chan error, 5)
					start := make(chan struct{})
					var wg sync.WaitGroup
					for range 5 {
						wg.Go(func() { <-start; s, e := model.RecordPaymentGuideView(30); results <- s; failures <- e })
					}
					close(start)
					wg.Wait()
					close(results)
					close(failures)
					for e := range failures {
						require.NoError(t, e)
					}
					displayed := 0
					for s := range results {
						if s.ShowGuide {
							displayed++
						}
					}
					assert.Equal(t, 3, displayed)
					state, err = model.GetPaymentGuideStatus(30)
					require.NoError(t, err)
					assert.Equal(t, 3, state.ShownCount)
				})
			}
		})
	}
}
