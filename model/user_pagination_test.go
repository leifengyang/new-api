package model

import (
	"fmt"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func insertUsersForPaginationTest(t *testing.T, total int) {
	t.Helper()
	for id := 1; id <= total; id++ {
		user := &User{
			Id:          id,
			Username:    fmt.Sprintf("user%02d", id),
			Password:    "password123",
			DisplayName: fmt.Sprintf("User %02d", id),
			Email:       fmt.Sprintf("user%02d@example.com", id),
			Role:        common.RoleCommonUser,
			Status:      common.UserStatusEnabled,
			Group:       "default",
			AffCode:     fmt.Sprintf("aff%02d", id),
		}
		require.NoError(t, DB.Create(user).Error)
	}
}

func collectUserIDs(users []*User) []int {
	ids := make([]int, 0, len(users))
	for _, user := range users {
		ids = append(ids, user.Id)
	}
	return ids
}

func TestGetAllUsersSortsBeforePagination(t *testing.T) {
	truncateTables(t)
	insertUsersForPaginationTest(t, 42)

	pageOne, total, err := GetAllUsers(&common.PageInfo{Page: 1, PageSize: 20}, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(42), total)
	assert.Equal(t, []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20}, collectUserIDs(pageOne))

	pageTwo, total, err := GetAllUsers(&common.PageInfo{Page: 2, PageSize: 20}, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(42), total)
	assert.Equal(t, []int{21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40}, collectUserIDs(pageTwo))

	pageThree, total, err := GetAllUsers(&common.PageInfo{Page: 3, PageSize: 20}, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(42), total)
	assert.Equal(t, []int{41, 42}, collectUserIDs(pageThree))
}

func TestSearchUsersSortsBeforePagination(t *testing.T) {
	truncateTables(t)
	insertUsersForPaginationTest(t, 42)

	users, total, err := SearchUsers("user", "", nil, nil, nil, nil, 20, 20, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(42), total)
	assert.Equal(t, []int{21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40}, collectUserIDs(users))
}

func TestSearchUsersFiltersByMemberLevel(t *testing.T) {
	truncateTables(t)
	insertUsersForPaginationTest(t, 12)
	require.NoError(t, DB.Model(&User{}).Where("id <= ?", 4).
		Update("member_level", MemberLevelInternal).Error)

	internal := MemberLevelInternal
	users, total, err := SearchUsers("user", "", nil, nil, &internal, nil, 0, 20, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(4), total)
	assert.Equal(t, []int{1, 2, 3, 4}, collectUserIDs(users))

	external := MemberLevelNormal
	users, total, err = SearchUsers("user", "", nil, nil, &external, nil, 0, 20, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(8), total)
	assert.Equal(t, []int{5, 6, 7, 8, 9, 10, 11, 12}, collectUserIDs(users))
}

func TestSearchUsersFiltersByEnterpriseFlag(t *testing.T) {
	truncateTables(t)
	insertUsersForPaginationTest(t, 12)
	require.NoError(t, DB.Model(&User{}).Where("id <= ?", 3).
		Update("is_enterprise", EnterpriseFlagYes).Error)

	enterprise := EnterpriseFlagYes
	users, total, err := SearchUsers("user", "", nil, nil, nil, &enterprise, 0, 20, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	assert.Equal(t, []int{1, 2, 3}, collectUserIDs(users))

	// 未标记的账号同样是可筛的取值：取消标记之后要能把这些账号单独列出来。
	notEnterprise := EnterpriseFlagNo
	users, total, err = SearchUsers("user", "", nil, nil, nil, &notEnterprise, 0, 20, NewUserSortOptions("id", "asc"))
	require.NoError(t, err)
	assert.Equal(t, int64(9), total)
	assert.Equal(t, []int{4, 5, 6, 7, 8, 9, 10, 11, 12}, collectUserIDs(users))
}

// is_enterprise 是这次新加的列表条件，属于 DB 层改动，SQLite 之外还得落到真实的
// MySQL / PostgreSQL 上跑一遍。库的准备直接复用返现矩阵那套（它本来就是「按方言
// 给一个干净库」的通用助手）：每次新建 SQLite 文件库，外部实例先 DROP 再
// AutoMigrate，省得上一轮的数据被 count 又数一遍。
func TestSearchUsersEnterpriseFilterDatabaseMatrix(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql", "postgres"} {
		t.Run(dialect, func(t *testing.T) {
			db := useInviteRebateMatrixDB(t, dialect)
			var version string
			versionQuery := "SELECT version()"
			if dialect == "sqlite" {
				versionQuery = "SELECT sqlite_version()"
			}
			require.NoError(t, db.Raw(versionQuery).Scan(&version).Error)
			t.Logf("%s version: %s", dialect, version)

			insertUsersForPaginationTest(t, 12)
			require.NoError(t, DB.Model(&User{}).Where("id <= ?", 3).
				Update("is_enterprise", EnterpriseFlagYes).Error)

			enterprise := EnterpriseFlagYes
			users, total, err := SearchUsers("user", "", nil, nil, nil, &enterprise, 0, 20, NewUserSortOptions("id", "asc"))
			require.NoError(t, err)
			assert.Equal(t, int64(3), total)
			assert.Equal(t, []int{1, 2, 3}, collectUserIDs(users))

			// 列迁移出来的默认值必须落在「不是企业账号」这一侧：老账号补上来的
			// 值要是非零，这里就会漏掉它们。
			notEnterprise := EnterpriseFlagNo
			users, total, err = SearchUsers("user", "", nil, nil, nil, &notEnterprise, 0, 20, NewUserSortOptions("id", "asc"))
			require.NoError(t, err)
			assert.Equal(t, int64(9), total)
			assert.Equal(t, []int{4, 5, 6, 7, 8, 9, 10, 11, 12}, collectUserIDs(users))

			// 不带条件时两种账号都要在：新参数只能是筛选，不能顺手改了默认列表。
			users, total, err = SearchUsers("user", "", nil, nil, nil, nil, 0, 20, NewUserSortOptions("id", "asc"))
			require.NoError(t, err)
			assert.Equal(t, int64(12), total)
			assert.Len(t, users, 12)
		})
	}
}
