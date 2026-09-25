package controller

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/service/authz"
	"github.com/alicebob/miniredis/v2"
	"github.com/go-redis/redis/v8"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func setupManageUserTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	require.NoError(t, i18n.Init())
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousRedisEnabled := common.RedisEnabled
	previousMainDatabaseType, previousLogDatabaseType := common.MainDatabaseType(), common.LogDatabaseType()
	dialect := os.Getenv("TEST_MANAGE_USER_DIALECT")
	if dialect == "" {
		dialect = "sqlite"
	}
	databaseTypes := map[string]common.DatabaseType{
		"sqlite": common.DatabaseTypeSQLite, "mysql": common.DatabaseTypeMySQL, "postgres": common.DatabaseTypePostgreSQL,
	}
	require.Contains(t, databaseTypes, dialect)
	dsn := os.Getenv("TEST_" + strings.ToUpper(dialect) + "_DSN")
	db, _ := newAuditTestDatabase(t, dialect, dsn)
	logDB := db
	if os.Getenv("TEST_MANAGE_USER_SEPARATE_LOG_DB") == "1" {
		logDB, _ = newAuditTestDatabase(t, dialect, dsn)
	}
	model.DB, model.LOG_DB = db, logDB
	common.RedisEnabled = false
	common.SetDatabaseTypes(databaseTypes[dialect], databaseTypes[dialect])

	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.RedisEnabled = previousRedisEnabled
		common.SetDatabaseTypes(previousMainDatabaseType, previousLogDatabaseType)
		sqlDB, err := db.DB()
		if err == nil {
			_ = sqlDB.Close()
		}
		if logDB != db {
			sqlLogDB, err := logDB.DB()
			if err == nil {
				_ = sqlLogDB.Close()
			}
		}
	})
	// User deletion walks every table that holds authentication data for the
	// account, so the fixture has to create them too.
	require.NoError(t, db.AutoMigrate(
		&model.User{}, &model.UserSession{}, &model.CasbinRule{}, &model.AuthzRole{},
		&model.Token{}, &model.TwoFA{}, &model.TwoFABackupCode{}, &model.PasskeyCredential{},
		&model.AuthFlow{}, &model.ExternalIdentityClaim{}, &model.UserOAuthBinding{},
	))
	require.NoError(t, logDB.AutoMigrate(&model.Log{}, &model.AuditLog{}))
	versionQuery := "SELECT version()"
	if dialect == "sqlite" {
		versionQuery = "SELECT sqlite_version()"
	}
	var version string
	require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
	t.Logf("database: %s %s, separate log database: %v", dialect, version, logDB != db)
	return db
}

func performManageUserRequest(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("id", 9999)
	c.Set("role", common.RoleRootUser)
	c.Set("username", "root-operator")
	c.Set(common.RequestIdKey, "quota-test-request")
	ManageUser(c)
	return recorder
}

func TestManageUserDisableAdvancesAuthVersionOnceAndRevokesSession(t *testing.T) {
	db := setupManageUserTestDB(t)
	now := time.Now().Unix()
	user := model.User{
		Username: "managed-disable-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	require.NoError(t, db.Create(&model.UserSession{
		SID: "managed-disable-session", UserID: user.Id, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "refresh-hash", LoginMethod: "password",
		LastActiveAt: now, ExpiresAt: now + 3600,
	}).Error)

	recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"disable"}`, user.Id))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.UserStatusDisabled, updated.Status)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var session model.UserSession
	require.NoError(t, db.First(&session, "sid = ?", "managed-disable-session").Error)
	assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
}

func TestManageUserDemoteAdvancesAuthVersionAndRevokesSessionsOnce(t *testing.T) {
	db := setupManageUserTestDB(t)
	previousMaster := common.IsMasterNode
	common.IsMasterNode = false
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	require.NoError(t, authz.Init(db))

	now := time.Now().Unix()
	user := model.User{
		Username: "managed-demote-user", Password: "password", Role: common.RoleAdminUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
	}
	require.NoError(t, db.Create(&user).Error)
	for _, sid := range []string{"managed-demote-session-one", "managed-demote-session-two"} {
		require.NoError(t, db.Create(&model.UserSession{
			SID: sid, UserID: user.Id, Version: 1, UserAuthVersion: 1,
			Status: model.UserSessionStatusActive, RefreshHash: "refresh-" + sid, LoginMethod: "password",
			LastActiveAt: now, ExpiresAt: now + 3600,
		}).Error)
	}

	sessionUpdateCount := 0
	require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:count_demote_session_updates", func(tx *gorm.DB) {
		if tx.Statement != nil && tx.Statement.Table == "user_sessions" {
			sessionUpdateCount++
		}
	}))

	recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"demote"}`, user.Id))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	var updated model.User
	require.NoError(t, db.First(&updated, user.Id).Error)
	assert.Equal(t, common.RoleCommonUser, updated.Role)
	assert.EqualValues(t, 2, updated.AuthVersion)
	var sessions []model.UserSession
	require.NoError(t, db.Where("user_id = ?", user.Id).Order("sid asc").Find(&sessions).Error)
	require.Len(t, sessions, 2)
	for _, session := range sessions {
		assert.Equal(t, model.UserSessionStatusRevoked, session.Status)
		assert.Equal(t, "admin_demote", session.RevokedReason)
	}
	assert.Equal(t, 1, sessionUpdateCount)
}

func TestManageUserDeleteReturnsImmediatelyAndUnknownActionFails(t *testing.T) {
	db := setupManageUserTestDB(t)
	deleted := model.User{
		Username: "managed-delete-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "delete-aff",
	}
	require.NoError(t, db.Create(&deleted).Error)

	recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"delete"}`, deleted.Id))
	assert.Contains(t, recorder.Body.String(), `"success":true`)
	var deletedCount int64
	require.NoError(t, db.Unscoped().Model(&model.User{}).Where("id = ? AND deleted_at IS NOT NULL", deleted.Id).Count(&deletedCount).Error)
	assert.EqualValues(t, 1, deletedCount)

	unchanged := model.User{
		Username: "managed-unknown-user", Password: "password", Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1, AffCode: "unknown-aff",
	}
	require.NoError(t, db.Create(&unchanged).Error)
	recorder = performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"unknown"}`, unchanged.Id))
	assert.Contains(t, recorder.Body.String(), `"success":false`)
	require.NoError(t, db.First(&unchanged, unchanged.Id).Error)
	assert.EqualValues(t, 1, unchanged.AuthVersion)
	assert.Equal(t, common.UserStatusEnabled, unchanged.Status)
}

// setupBatchDeleteOperator creates the acting administrator with a live session,
// which is what the step-up verification validates the proof against.
func setupBatchDeleteOperator(t *testing.T, db *gorm.DB, role int) (model.User, service.AuthIdentity) {
	t.Helper()
	previousSecret := common.SessionSecret
	common.SessionSecret = "batch-delete-test-secret"
	t.Cleanup(func() { common.SessionSecret = previousSecret })
	password, err := common.Password2Hash("operator-password")
	require.NoError(t, err)
	operator := model.User{
		Id: 9999, Username: "root-operator", Password: password, Role: role,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1,
		AffCode: "batch-operator-aff",
	}
	require.NoError(t, db.Create(&operator).Error)
	require.NoError(t, model.PublishUserAuthCache(operator.Id))
	bundle, err := service.CreateLoginSession(operator.Id, "password", "127.0.0.1", "batch-delete-test")
	require.NoError(t, err)
	identity, err := service.ParseAccessToken(bundle.AccessToken)
	require.NoError(t, err)
	return operator, identity
}

func issueBatchDeleteProof(t *testing.T, identity service.AuthIdentity, ids []int) string {
	t.Helper()
	context, err := common.Marshal(service.UserBatchDeleteContext{UserIDs: ids})
	require.NoError(t, err)
	binding, err := service.BindVerificationOperation(service.VerificationOperation{
		Scope: service.VerificationScopeUserBatchDelete, Context: context,
	})
	require.NoError(t, err)
	proof, _, err := service.IssueSecurityProof(identity, service.VerificationMethodPassword, binding)
	require.NoError(t, err)
	return proof
}

func performDeleteUserBatchRequest(t *testing.T, identity service.AuthIdentity, role int, body, proof string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/user/batch", strings.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	if proof != "" {
		c.Request.Header.Set("X-Security-Proof", proof)
	}
	c.Set("id", identity.UserID)
	c.Set("role", role)
	c.Set("session_id", identity.SessionID)
	c.Set("auth_version", identity.UserAuthVersion)
	c.Set("session_version", identity.SessionVersion)
	c.Set("username", "root-operator")
	c.Set(common.RequestIdKey, "batch-delete-test-request")
	DeleteUserBatch(c)
	return recorder
}

func TestDeleteUserBatchEnforcesRoleAndDeletesAtomically(t *testing.T) {
	for _, tc := range []struct {
		name          string
		operatorRole  int
		targets       []model.User
		insertMissing bool
		duplicateIds  bool
		// proof selects a request that must be refused before the model runs:
		// "missing" sends none, "other-ids" sends one bound to another selection,
		// "junk" sends an unusable one so the malformed selection is reached.
		proof       string
		wantCode    string
		wantStatus  int
		wantSuccess bool
		wantDeleted int64
		wantMessage string
	}{
		{
			name: "root deletes common users", operatorRole: common.RoleRootUser,
			targets:     []model.User{{Username: "batch-common-one", Role: common.RoleCommonUser}, {Username: "batch-common-two", Role: common.RoleCommonUser}},
			wantSuccess: true, wantDeleted: 2,
		},
		{
			name: "admin deletes a common user", operatorRole: common.RoleAdminUser,
			targets:     []model.User{{Username: "batch-admin-common", Role: common.RoleCommonUser}},
			wantSuccess: true, wantDeleted: 1,
		},
		{
			name: "admin cannot delete a peer admin", operatorRole: common.RoleAdminUser,
			targets:     []model.User{{Username: "batch-peer-admin", Role: common.RoleAdminUser}},
			wantMessage: i18n.MsgUserNoPermissionHigherLevel,
		},
		{
			name: "admin cannot delete a root account", operatorRole: common.RoleAdminUser,
			targets:     []model.User{{Username: "batch-root-target", Role: common.RoleRootUser}},
			wantMessage: i18n.MsgUserNoPermissionHigherLevel,
		},
		{
			name: "root cannot delete another root account", operatorRole: common.RoleRootUser,
			targets:     []model.User{{Username: "batch-self", Role: common.RoleRootUser}},
			wantMessage: i18n.MsgUserNoPermissionHigherLevel,
		},
		{
			// The undeletable row is second on purpose: deleting row by row
			// would already have removed the first one before it noticed.
			name: "one refused target keeps the whole batch", operatorRole: common.RoleAdminUser,
			targets:     []model.User{{Username: "batch-kept-common", Role: common.RoleCommonUser}, {Username: "batch-kept-admin", Role: common.RoleAdminUser}},
			wantMessage: i18n.MsgUserNoPermissionHigherLevel,
		},
		{
			name: "an unknown target refuses the batch", operatorRole: common.RoleRootUser,
			targets:       []model.User{{Username: "batch-known", Role: common.RoleCommonUser}},
			insertMissing: true,
			wantMessage:   i18n.MsgUserNotExists,
		},
		{
			// An empty selection cannot be bound to a proof at all, so it is
			// rejected as malformed action details before the model is reached.
			name: "empty selection is refused", operatorRole: common.RoleRootUser,
			proof:      "junk",
			wantCode:   "SECURITY_CONTEXT_INVALID",
			wantStatus: http.StatusBadRequest,
		},
		{
			name: "duplicate ids are deleted once", operatorRole: common.RoleRootUser,
			targets:      []model.User{{Username: "batch-duplicate", Role: common.RoleCommonUser}},
			duplicateIds: true,
			wantSuccess:  true, wantDeleted: 1,
		},
		{
			name: "the request is refused without a proof", operatorRole: common.RoleRootUser,
			targets:  []model.User{{Username: "batch-no-proof", Role: common.RoleCommonUser}},
			proof:    "missing",
			wantCode: "SECURITY_PROOF_REQUIRED",
		},
		{
			name: "a proof for another selection is refused", operatorRole: common.RoleRootUser,
			targets:  []model.User{{Username: "batch-other-proof", Role: common.RoleCommonUser}},
			proof:    "other-ids",
			wantCode: "SECURITY_PROOF_CONTEXT_MISMATCH",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			ids := make([]int, 0, len(tc.targets))
			for i := range tc.targets {
				tc.targets[i].Password = "password"
				tc.targets[i].Status = common.UserStatusEnabled
				tc.targets[i].AuthVersion = 1
				// aff_code carries a unique index, so two fixtures sharing the
				// empty default would collide. It is also varchar(32), so the
				// code has to stay short; the username is already unique here.
				tc.targets[i].AffCode = fmt.Sprintf("aff-%s-%d", tc.targets[i].Username, i)
				require.NoError(t, db.Create(&tc.targets[i]).Error)
				ids = append(ids, tc.targets[i].Id)
			}
			if tc.duplicateIds {
				ids = append(ids, ids[0])
			}
			if tc.insertMissing {
				ids = append(ids, 404)
			}

			_, identity := setupBatchDeleteOperator(t, db, tc.operatorRole)
			// The empty selection cannot be bound to a proof at all, so only the
			// cases that carry a usable one mint it here.
			var proof string
			switch tc.proof {
			case "missing":
			case "other-ids":
				proof = issueBatchDeleteProof(t, identity, []int{999998})
			case "junk":
				proof = "not-a-proof"
			default:
				proof = issueBatchDeleteProof(t, identity, ids)
			}

			body, err := common.Marshal(map[string]any{"ids": ids})
			require.NoError(t, err)
			recorder := performDeleteUserBatchRequest(t, identity, tc.operatorRole, string(body), proof)
			if tc.wantCode != "" {
				status := tc.wantStatus
				if status == 0 {
					status = http.StatusForbidden
				}
				assert.Equal(t, status, recorder.Code)
				assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"code":"%s"`, tc.wantCode))
			} else {
				assert.Equal(t, http.StatusOK, recorder.Code)
				require.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, tc.wantSuccess))
				if tc.wantSuccess {
					assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"data":%d`, tc.wantDeleted))
				} else {
					assert.Contains(t, recorder.Body.String(), i18n.Translate("en", tc.wantMessage))
				}
			}

			for _, target := range tc.targets {
				var kept model.User
				err := db.Unscoped().First(&kept, target.Id).Error
				if tc.wantSuccess {
					assert.ErrorIs(t, err, gorm.ErrRecordNotFound, "hard delete must remove the row entirely")
					continue
				}
				require.NoError(t, err, "a refused batch must not delete anything")
				assert.EqualValues(t, 1, kept.AuthVersion, "a refused batch must not bump auth versions")
			}
		})
	}
}

func TestDeleteUserBatchRemovesAuthenticationDataAndAudits(t *testing.T) {
	db := setupManageUserTestDB(t)
	now := time.Now().Unix()
	user := model.User{Username: "batch-auth-owner", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "batch-auth-aff"}
	require.NoError(t, db.Create(&user).Error)
	require.NoError(t, db.Create(&model.Token{UserId: user.Id, Key: "batch-auth-token"}).Error)
	require.NoError(t, db.Create(&model.UserSession{
		SID: "batch-auth-session", UserID: user.Id, Version: 1, UserAuthVersion: 1,
		Status: model.UserSessionStatusActive, RefreshHash: "refresh-hash", LoginMethod: "password",
		LastActiveAt: now, ExpiresAt: now + 3600,
	}).Error)

	_, identity := setupBatchDeleteOperator(t, db, common.RoleRootUser)
	proof := issueBatchDeleteProof(t, identity, []int{user.Id})
	recorder := performDeleteUserBatchRequest(t, identity, common.RoleRootUser, fmt.Sprintf(`{"ids":[%d]}`, user.Id), proof)
	assert.Contains(t, recorder.Body.String(), `"success":true`)

	for _, record := range []any{&model.Token{}, &model.UserSession{}} {
		var count int64
		require.NoError(t, db.Unscoped().Model(record).Where("user_id = ?", user.Id).Count(&count).Error)
		assert.Zero(t, count)
	}

	var audits []model.AuditLog
	require.NoError(t, model.LOG_DB.Find(&audits).Error)
	require.Len(t, audits, 1)
	assert.Equal(t, "user.delete_batch", audits[0].Action)
	assert.True(t, audits[0].Success)
	params, err := common.Marshal(audits[0].Other.Op.Params)
	require.NoError(t, err)
	assert.Contains(t, string(params), `"count":1`)
	assert.Contains(t, string(params), `"requested":1`)
	assert.NotContains(t, string(params), user.Username, "the audit must not leak the deleted account name")
}

// The proof is what stands in for the operator's password, so it has to be
// worth exactly one batch of exactly the accounts it was issued for.
func TestDeleteUserBatchProofIsSingleUseAndScopeBound(t *testing.T) {
	db := setupManageUserTestDB(t)
	first := model.User{Username: "batch-proof-first", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "batch-proof-first-aff"}
	second := model.User{Username: "batch-proof-second", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "batch-proof-second-aff"}
	require.NoError(t, db.Create(&first).Error)
	require.NoError(t, db.Create(&second).Error)
	_, identity := setupBatchDeleteOperator(t, db, common.RoleRootUser)

	// stillPresent is what tells a refused batch from an executed one; the row
	// is hard deleted, so unscoped lookups see exactly the same thing.
	stillPresent := func(id int) bool {
		var found model.User
		return db.Unscoped().First(&found, id).Error == nil
	}

	firstBody, err := common.Marshal(map[string]any{"ids": []int{first.Id}})
	require.NoError(t, err)

	// A proof minted for another sensitive action must not be accepted here.
	otherBinding, err := service.BindVerificationOperation(service.VerificationOperation{Scope: service.VerificationScopeAccountDelete})
	require.NoError(t, err)
	otherProof, _, err := service.IssueSecurityProof(identity, service.VerificationMethodPassword, otherBinding)
	require.NoError(t, err)
	recorder := performDeleteUserBatchRequest(t, identity, common.RoleRootUser, string(firstBody), otherProof)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"code":"SECURITY_PROOF_SCOPE_MISMATCH"`)
	assert.True(t, stillPresent(first.Id), "a proof for another scope must delete nothing")

	proof := issueBatchDeleteProof(t, identity, []int{first.Id})
	recorder = performDeleteUserBatchRequest(t, identity, common.RoleRootUser, string(firstBody), proof)
	require.Contains(t, recorder.Body.String(), `"success":true`)
	assert.False(t, stillPresent(first.Id), "the authorized batch must remove the row")

	// Replaying the same proof is refused, and it cannot be redirected at
	// another selection either.
	recorder = performDeleteUserBatchRequest(t, identity, common.RoleRootUser, string(firstBody), proof)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"code":"SECURITY_PROOF_CONSUMED"`)
	secondBody, err := common.Marshal(map[string]any{"ids": []int{second.Id}})
	require.NoError(t, err)
	recorder = performDeleteUserBatchRequest(t, identity, common.RoleRootUser, string(secondBody), proof)
	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.Contains(t, recorder.Body.String(), `"code":"SECURITY_PROOF_CONTEXT_MISMATCH"`)
	assert.True(t, stillPresent(second.Id), "a spent proof must not delete another selection")
}

func TestDeleteUserBatchVerificationRequirements(t *testing.T) {
	t.Run("a non-admin cannot verify for the batch delete", func(t *testing.T) {
		db := setupManageUserTestDB(t)
		target := model.User{Username: "batch-non-admin-target", Password: "password", Role: common.RoleCommonUser, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "batch-non-admin-aff"}
		require.NoError(t, db.Create(&target).Error)
		_, identity := setupBatchDeleteOperator(t, db, common.RoleCommonUser)

		// The scope is refused before a method is chosen, so a common account
		// cannot obtain a proof for an admin-only endpoint.
		_, err := service.GetVerificationRequirements(identity, service.VerificationScopeUserBatchDelete)
		assert.ErrorIs(t, err, service.ErrVerificationForbidden)

		body, err := common.Marshal(map[string]any{"ids": []int{target.Id}})
		require.NoError(t, err)
		proof := issueBatchDeleteProof(t, identity, []int{target.Id})
		recorder := performDeleteUserBatchRequest(t, identity, common.RoleCommonUser, string(body), proof)
		assert.Equal(t, http.StatusForbidden, recorder.Code)
		assert.Contains(t, recorder.Body.String(), `"code":"SECURITY_ACTION_FORBIDDEN"`)
		var kept model.User
		require.NoError(t, db.First(&kept, target.Id).Error)
	})

	t.Run("the account password is the fallback factor", func(t *testing.T) {
		db := setupManageUserTestDB(t)
		_, identity := setupBatchDeleteOperator(t, db, common.RoleAdminUser)
		requirements, err := service.GetVerificationRequirements(identity, service.VerificationScopeUserBatchDelete)
		require.NoError(t, err)
		assert.Equal(t, []service.VerificationMethodOption{{Method: service.VerificationMethodPassword, Available: true}}, requirements.Methods)
	})

	t.Run("an enrolled second factor replaces the password", func(t *testing.T) {
		db := setupManageUserTestDB(t)
		operator, identity := setupBatchDeleteOperator(t, db, common.RoleAdminUser)
		require.NoError(t, db.Create(&model.TwoFA{UserId: operator.Id, Secret: "JBSWY3DPEHPK3PXP", IsEnabled: true}).Error)

		requirements, err := service.GetVerificationRequirements(identity, service.VerificationScopeUserBatchDelete)
		require.NoError(t, err)
		assert.Equal(t, []service.VerificationMethodOption{{Method: service.VerificationMethodTwoFA, Available: true}}, requirements.Methods)
		// Deleting accounts is highly sensitive, so the enrolled factor is
		// required rather than offered alongside a password that may be weaker.
		_, err = service.RequireVerificationMethod(identity, service.VerificationScopeUserBatchDelete, service.VerificationMethodPassword)
		assert.ErrorIs(t, err, service.ErrProofMethod)
	})

	t.Run("a disabled password login removes the password method", func(t *testing.T) {
		db := setupManageUserTestDB(t)
		_, identity := setupBatchDeleteOperator(t, db, common.RoleAdminUser)
		previous := common.PasswordLoginEnabled
		common.PasswordLoginEnabled = false
		t.Cleanup(func() { common.PasswordLoginEnabled = previous })

		requirements, err := service.GetVerificationRequirements(identity, service.VerificationScopeUserBatchDelete)
		require.NoError(t, err)
		require.Len(t, requirements.Methods, 1)
		assert.Equal(t, service.VerificationMethodPassword, requirements.Methods[0].Method)
		assert.False(t, requirements.Methods[0].Available)
		assert.Equal(t, "Password authentication is disabled.", requirements.Methods[0].Reason)
	})

	t.Run("the selection is normalized and bounded", func(t *testing.T) {
		setupManageUserTestDB(t)
		bind := func(ids []int) (service.VerificationBinding, error) {
			context, err := common.Marshal(service.UserBatchDeleteContext{UserIDs: ids})
			require.NoError(t, err)
			return service.BindVerificationOperation(service.VerificationOperation{
				Scope: service.VerificationScopeUserBatchDelete, Context: context,
			})
		}

		// The order and any duplicates the client sends must not change what the
		// proof is bound to, or a verification and its delete request would hash
		// differently for the same selection.
		withDuplicates, err := bind([]int{4, 3, 4})
		require.NoError(t, err)
		sorted, err := bind([]int{3, 4})
		require.NoError(t, err)
		assert.Equal(t, sorted.ContextHash, withDuplicates.ContextHash)

		_, err = bind(nil)
		assert.ErrorIs(t, err, service.ErrVerificationContextInvalid)
		_, err = bind([]int{0})
		assert.ErrorIs(t, err, service.ErrVerificationContextInvalid)
		overCap := make([]int, 0, model.MaxBatchDeleteUsers+1)
		for id := range model.MaxBatchDeleteUsers + 1 {
			overCap = append(overCap, id+1)
		}
		_, err = bind(overCap)
		assert.ErrorIs(t, err, service.ErrVerificationContextInvalid)
	})
}

func createQuotaTestOperator(t *testing.T, db *gorm.DB, role int) model.User {
	t.Helper()
	if role == 0 {
		role = common.RoleRootUser
	}
	operator := model.User{Id: 9999, Username: "root-operator", Role: role, Status: common.UserStatusEnabled, AuthVersion: 1, AffCode: "root-operator-aff"}
	require.NoError(t, db.Create(&operator).Error)
	return operator
}

func TestManageUserQuotaRecordsTopupAndAudit(t *testing.T) {
	for _, tc := range []struct {
		name, mode, action, content string
		value, wantQuota            int
	}{
		{"add", "add", "user.quota_add", "Increased user quota by 500", 500, 1500},
		{"subtract", "subtract", "user.quota_subtract", "Decreased user quota by 500", 500, 500},
		{"override_up", "override", "user.quota_override", "Overrode user quota from 1000 to 1500", 1500, 1500},
		{"override_down", "override", "user.quota_override", "Overrode user quota from 1000 to 500", 500, 500},
		{"override_unchanged", "override", "user.quota_override", "Overrode user quota from 1000 to 1000", 1000, 1000},
		{"override_zero", "override", "user.quota_override", "Overrode user quota from 1000 to 0", 0, 0},
		{"override_negative", "override", "user.quota_override", "Overrode user quota from 1000 to -1", -1, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000, AffCode: "quota-owner-aff"}
			require.NoError(t, db.Create(&user).Error)
			createQuotaTestOperator(t, db, common.RoleRootUser)

			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Equal(t, http.StatusOK, recorder.Code)
			require.Contains(t, recorder.Body.String(), `"success":true`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.wantQuota, user.Quota)

			logs, total, err := model.GetAllLogs(model.LogTypeTopup, 0, 0, "", "", "", 0, 20, 0, "", "", "")
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, logs, 1)
			assert.Equal(t, user.Id, logs[0].UserId)
			assert.Equal(t, user.Username, logs[0].Username)
			assert.Equal(t, tc.content, logs[0].Content)
			model.FormatAdminLogs(logs)
			var other model.AuditOther
			require.NoError(t, common.UnmarshalJsonStr(logs[0].Other, &other))
			assert.Equal(t, &model.AuditAdminInfo{AdminID: 9999, AdminUsername: "root-operator", AdminRole: common.RoleRootUser, AuthMethod: "session"}, other.AdminInfo)

			logs, total, err = model.GetUserLogs(user.Id, model.LogTypeTopup, 0, 0, "", "", 0, 20, "", "", "")
			require.NoError(t, err)
			assert.EqualValues(t, 1, total)
			require.Len(t, logs, 1)
			other = model.AuditOther{}
			require.NoError(t, common.UnmarshalJsonStr(logs[0].Other, &other))
			assert.Nil(t, other.AdminInfo)
			require.NotNil(t, other.Op)
			assert.Equal(t, tc.action, other.Op.Action)
			params, err := common.Marshal(other.Op.Params)
			require.NoError(t, err)
			expectedParams := model.AuditFields{"target_user_id": user.Id, "target_username": user.Username, "mode": tc.mode, "requested_quota": tc.value, "from": 1000, "to": tc.wantQuota}
			if tc.mode != "override" {
				expectedParams["quota"] = tc.value
			}
			expected, err := common.Marshal(expectedParams)
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.Equal(t, "quota-test-request", logs[0].RequestId)
			assert.Empty(t, logs[0].Ip, "recipient logs must not disclose the administrator IP")

			logs, total, err = model.GetUserLogs(9999, model.LogTypeTopup, 0, 0, "", "", 0, 20, "", "", "")
			require.NoError(t, err)
			assert.Zero(t, total)
			assert.Empty(t, logs)
			var audits []model.AuditLog
			require.NoError(t, model.LOG_DB.Find(&audits).Error)
			require.Len(t, audits, 1)
			assert.Equal(t, 9999, audits[0].UserId)
			assert.Equal(t, "root-operator", audits[0].Username)
			assert.Equal(t, tc.action, audits[0].Action)
			assert.True(t, audits[0].Success)
			params, err = common.Marshal(audits[0].Other.Op.Params)
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.Equal(t, "quota-test-request", audits[0].RequestId)
		})
	}
}

func TestManageUserQuotaFailuresDoNotRecordTopup(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		value      int
		failUpdate bool
	}{
		{"zero_add", "add", 0, false},
		{"negative_subtract", "subtract", -1, false},
		{"invalid_mode", "invalid", 500, false},
		{"add_update_error", "add", 500, true},
		{"subtract_update_error", "subtract", 500, true},
		{"override_update_error", "override", 500, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, common.RoleRootUser)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			if tc.failUpdate {
				require.NoError(t, db.Callback().Update().Before("gorm:update").Register("test:fail_quota_update", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("quota update unavailable"))
					}
				}))
			}
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Contains(t, recorder.Body.String(), `"success":false`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1000, user.Quota)
			var logCount, auditCount int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logCount).Error)
			require.NoError(t, model.LOG_DB.Model(&model.AuditLog{}).Count(&auditCount).Error)
			assert.Zero(t, logCount)
			assert.EqualValues(t, 1, auditCount)
			var audit model.AuditLog
			require.NoError(t, model.LOG_DB.First(&audit).Error)
			assert.False(t, audit.Success)
			params, err := common.Marshal(audit.Other.Op.Params)
			require.NoError(t, err)
			assert.NotContains(t, string(params), `"from"`)
			assert.NotContains(t, string(params), `"to"`)
			assert.NotContains(t, string(params), `"target_username"`)
			assert.NotContains(t, string(params), "quota update unavailable")
			reason := "invalid_parameters"
			if tc.failUpdate {
				reason = "database_error"
			}
			assert.Contains(t, string(params), `"failure_reason":"`+reason+`"`)
			assert.Contains(t, string(params), fmt.Sprintf(`"requested_quota":%d`, tc.value))
		})
	}
}

func TestManageUserQuotaLogFailureKeepsSuccessfulAdjustment(t *testing.T) {
	for _, failedTable := range []string{"logs", "audit_logs"} {
		t.Run(failedTable, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, common.RoleRootUser)
			user := model.User{Username: "quota-owner", Role: common.RoleCommonUser, Quota: 1000}
			require.NoError(t, db.Create(&user).Error)
			require.NoError(t, model.LOG_DB.Callback().Create().Before("gorm:create").Register("test:fail_quota_log", func(tx *gorm.DB) {
				if tx.Statement.Table == failedTable {
					tx.AddError(errors.New("quota log unavailable"))
				}
			}))
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":"add","value":500}`, user.Id))
			assert.Contains(t, recorder.Body.String(), `"success":true`)
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, 1500, user.Quota)
			var logCount, auditCount int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&logCount).Error)
			require.NoError(t, model.LOG_DB.Model(&model.AuditLog{}).Count(&auditCount).Error)
			if failedTable == "logs" {
				assert.Zero(t, logCount)
				assert.EqualValues(t, 1, auditCount)
			} else {
				assert.EqualValues(t, 1, logCount)
				assert.Zero(t, auditCount)
			}
		})
	}
}

func TestManageUserQuotaTargetsAndWalletBounds(t *testing.T) {
	for _, tc := range []struct {
		name, mode, reason                                string
		before, value, targetID, targetRole, operatorRole int
		deleted, failRead                                 bool
	}{
		{name: "zero_id", mode: "add", value: 1, reason: "invalid_parameters"},
		{name: "negative_id", mode: "subtract", value: 1, targetID: -1, reason: "invalid_parameters"},
		{name: "missing", mode: "override", value: 1, targetID: 12345, reason: "target_not_found"},
		{name: "deleted", mode: "add", value: 1, targetID: 1, deleted: true, reason: "target_not_found"},
		{name: "peer_admin", mode: "add", value: 1, targetID: 1, targetRole: common.RoleAdminUser, operatorRole: common.RoleAdminUser, reason: "permission_denied"},
		{name: "higher_role", mode: "override", value: 1, targetID: 1, targetRole: common.RoleRootUser, operatorRole: common.RoleAdminUser, reason: "permission_denied"},
		{name: "read_error", mode: "add", value: 1, targetID: 1, failRead: true, reason: "database_error"},
		{name: "add_overflow", mode: "add", before: common.MaxWalletQuota, value: 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "subtract_underflow", mode: "subtract", before: -common.MaxWalletQuota, value: 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_add", mode: "add", value: common.MaxWalletQuota + 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_subtract", mode: "subtract", value: common.MaxWalletQuota + 1, targetID: 1, reason: "quota_limit_exceeded"},
		{name: "oversized_override", mode: "override", value: -common.MaxWalletQuota - 1, targetID: 1, reason: "quota_limit_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			createQuotaTestOperator(t, db, tc.operatorRole)
			user := model.User{Id: 1, Username: "private-target-name", Role: tc.targetRole, Quota: tc.before}
			require.NoError(t, db.Create(&user).Error)
			if tc.deleted {
				require.NoError(t, db.Delete(&user).Error)
			}
			if tc.failRead {
				require.NoError(t, db.Callback().Query().Before("gorm:query").Register("test:quota_read_error", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" && len(tx.Statement.Selects) == 0 {
						tx.AddError(errors.New("private database error"))
					}
				}))
			}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			c.Request = httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, tc.targetID, tc.mode, tc.value)))
			role := tc.operatorRole
			if role == 0 {
				role = common.RoleRootUser
			}
			c.Set("id", 9999)
			c.Set("role", role)
			ManageUser(c)
			require.Contains(t, recorder.Body.String(), `"success":false`)
			if tc.failRead {
				require.NoError(t, db.Callback().Query().Remove("test:quota_read_error"))
			}
			require.NoError(t, db.Unscoped().First(&user, user.Id).Error)
			assert.Equal(t, tc.before, user.Quota)
			var audits []model.AuditLog
			require.NoError(t, model.LOG_DB.Find(&audits).Error)
			require.Len(t, audits, 1)
			assert.False(t, audits[0].Success)
			params, err := common.Marshal(audits[0].Other.Op.Params)
			require.NoError(t, err)
			expected, err := common.Marshal(model.AuditFields{"target_user_id": tc.targetID, "mode": tc.mode, "requested_quota": tc.value, "failure_reason": tc.reason})
			require.NoError(t, err)
			assert.JSONEq(t, string(expected), string(params))
			assert.NotContains(t, audits[0].Content, user.Username)
			var count int64
			require.NoError(t, model.LOG_DB.Model(&model.Log{}).Count(&count).Error)
			assert.Zero(t, count)
		})
	}
}

func TestManageUserQuotaMiddlewareKeepsOneOperationPerRequest(t *testing.T) {
	db := setupManageUserTestDB(t)
	pat := "quota-middleware-test-token"
	operator := model.User{Id: 9999, Username: "root-operator", Role: common.RoleRootUser, Status: common.UserStatusEnabled, AuthVersion: 1, AccessToken: &pat, Quota: 1000}
	require.NoError(t, db.Create(&operator).Error)
	router := gin.New()
	router.Use(middleware.RequestId(), middleware.AccessTokenAudit())
	router.POST("/api/user/manage", middleware.AdminAuth(), ManageUser)
	for _, tc := range []struct {
		body, action string
		success      bool
	}{
		{`{"id":9999,"action":"add_quota","mode":"add","value":100}`, "user.quota_add", true},
		{`{"id":9999,"action":"add_quota","mode":"subtract","value":0}`, "user.quota_subtract", false},
		{`{"id":9999,"action":"add_quota","mode":"invalid","value":1}`, "generic", false},
		{`{"id":`, "generic", false},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/user/manage", strings.NewReader(tc.body))
		request.Header.Set("Authorization", "Bearer "+pat)
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusOK, recorder.Code)
		assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, tc.success))
		requestID := recorder.Header().Get(common.RequestIdKey)
		require.NotEmpty(t, requestID)
		var audits []model.AuditLog
		require.NoError(t, model.LOG_DB.Where("request_id = ?", requestID).Find(&audits).Error)
		require.Len(t, audits, 2, "one operation audit and one PAT request audit")
		for _, audit := range audits {
			assert.Equal(t, tc.success, audit.Success)
			if audit.Category != model.AuditCategoryOperation {
				continue
			}
			assert.Equal(t, tc.action, audit.Action)
			assert.Equal(t, operator.Id, audit.UserId)
			assert.Equal(t, "/api/user/manage", audit.Route)
			if tc.success {
				params, err := common.Marshal(audit.Other.Op.Params)
				require.NoError(t, err)
				assert.Contains(t, string(params), `"target_user_id":9999`)
				assert.Contains(t, string(params), `"target_username":"root-operator"`)
			}
		}
		var count int64
		require.NoError(t, model.LOG_DB.Model(&model.Log{}).Where("request_id = ?", requestID).Count(&count).Error)
		if tc.success {
			assert.EqualValues(t, 1, count)
		} else {
			assert.Zero(t, count)
		}
	}
	require.NoError(t, db.First(&operator, operator.Id).Error)
	assert.Equal(t, 1100, operator.Quota)
}

func TestManageUserQuotaConcurrentSnapshots(t *testing.T) {
	db := setupManageUserTestDB(t)
	user := model.User{Username: "concurrent-quota", Quota: 1000}
	require.NoError(t, db.Create(&user).Error)
	var ready sync.WaitGroup
	ready.Add(2)
	release := make(chan struct{})
	require.NoError(t, db.Callback().Query().Before("gorm:query").Register("test:concurrent_quota_start", func(tx *gorm.DB) {
		if tx.Statement.Table == "users" {
			ready.Done()
			<-release
		}
	}))
	type result struct {
		adjustment *model.UserQuotaAdjustment
		err        error
		value      int
	}
	results := make(chan result, 2)
	for _, value := range []int{10, 20} {
		go func(value int) {
			adjustment, err := model.AdjustUserQuota(user.Id, common.RoleRootUser, "add", value)
			results <- result{adjustment, err, value}
		}(value)
	}
	ready.Wait()
	close(release)
	var committed []model.UserQuotaAdjustment
	for range 2 {
		result := <-results
		if result.err != nil {
			require.True(t, common.UsingMainDatabase(common.DatabaseTypeSQLite), "row-locking databases must serialize both adjustments: %v", result.err)
			assert.Contains(t, strings.ToLower(result.err.Error()), "locked")
			assert.Nil(t, result.adjustment)
			continue
		}
		require.NotNil(t, result.adjustment)
		assert.Equal(t, result.value, result.adjustment.After-result.adjustment.Before)
		committed = append(committed, *result.adjustment)
	}
	require.NoError(t, db.Callback().Query().Remove("test:concurrent_quota_start"))
	require.NotEmpty(t, committed)
	sort.Slice(committed, func(i, j int) bool { return committed[i].Before < committed[j].Before })
	balance := 1000
	for _, adjustment := range committed {
		assert.Equal(t, balance, adjustment.Before)
		balance = adjustment.After
	}
	require.NoError(t, db.First(&user, user.Id).Error)
	assert.Equal(t, balance, user.Quota)
}

func TestManageUserQuotaCacheUsesCommittedIntegerDifference(t *testing.T) {
	for _, tc := range []struct {
		name, mode                               string
		before, cached, value, after, wantCached int
		failUpdate, failCache, missingCache      bool
	}{
		{name: "add_preserves_reservations", mode: "add", before: 1000, cached: 900, value: 500, after: 1500, wantCached: 1400},
		{name: "subtract_preserves_reservations", mode: "subtract", before: 1000, cached: 900, value: 500, after: 500, wantCached: 400},
		{name: "override_preserves_reservations", mode: "override", before: 1000, cached: 900, value: 2000, after: 2000, wantCached: 1900},
		{name: "large_odd_difference", mode: "override", before: common.MaxWalletQuota - 1, cached: common.MaxWalletQuota - 1, value: -common.MaxWalletQuota, after: -common.MaxWalletQuota, wantCached: -common.MaxWalletQuota},
		{name: "rollback_does_not_change_cache", mode: "subtract", before: 1000, cached: 900, value: 500, after: 1000, wantCached: 900, failUpdate: true},
		{name: "cache_error_keeps_committed_change", mode: "add", before: 1000, value: 500, after: 1500, failCache: true},
		{name: "missing_cache_is_not_partially_created", mode: "add", before: 1000, value: 500, after: 1500, missingCache: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := setupManageUserTestDB(t)
			operator := createQuotaTestOperator(t, db, common.RoleRootUser)
			server := miniredis.RunT(t)
			oldRDB := common.RDB
			common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr(), MaxRetries: -1})
			common.RedisEnabled = true
			t.Cleanup(func() { _ = common.RDB.Close(); common.RDB = oldRDB })
			user := model.User{Username: "cached-quota", Quota: tc.before, AuthVersion: 1}
			require.NoError(t, db.Create(&user).Error)
			cache, err := model.GetUserCache(user.Id)
			require.NoError(t, err)
			assert.Equal(t, tc.before, cache.Quota)
			_, err = model.GetUserCache(operator.Id)
			require.NoError(t, err)
			keys := server.Keys()
			var quotaKey string
			for _, key := range keys {
				if server.HGet(key, "Id") == strconv.Itoa(user.Id) && server.HGet(key, "Quota") != "" {
					quotaKey = key
					break
				}
			}
			require.NotEmpty(t, quotaKey)
			server.HSet(quotaKey, "Quota", strconv.Itoa(tc.cached))
			if tc.missingCache {
				server.Del(quotaKey)
			}
			if tc.failCache {
				server.SetError("ERR quota cache unavailable")
			}
			if tc.failUpdate {
				require.NoError(t, db.Callback().Update().After("gorm:update").Register("test:cache_quota_rollback", func(tx *gorm.DB) {
					if tx.Statement.Table == "users" {
						tx.AddError(errors.New("quota rollback"))
					}
				}))
			}
			recorder := performManageUserRequest(t, fmt.Sprintf(`{"id":%d,"action":"add_quota","mode":%q,"value":%d}`, user.Id, tc.mode, tc.value))
			assert.Contains(t, recorder.Body.String(), fmt.Sprintf(`"success":%t`, !tc.failUpdate))
			require.NoError(t, db.First(&user, user.Id).Error)
			assert.Equal(t, tc.after, user.Quota)
			if tc.missingCache {
				// Log username lookup may hydrate the whole user after commit.
				if server.Exists(quotaKey) {
					assert.Equal(t, strconv.Itoa(user.Id), server.HGet(quotaKey, "Id"))
					assert.NotEmpty(t, server.HGet(quotaKey, "CacheSchema"))
					assert.Equal(t, strconv.Itoa(tc.after), server.HGet(quotaKey, "Quota"))
				}
			} else if !tc.failCache {
				assert.Equal(t, strconv.Itoa(tc.wantCached), server.HGet(quotaKey, "Quota"))
			}
		})
	}
}
