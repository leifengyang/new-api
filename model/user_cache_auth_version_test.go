package model

import (
	"errors"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func useUserCacheMiniRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	oldRedisEnabled := common.RedisEnabled
	oldRDB := common.RDB
	oldSyncFrequency := common.SyncFrequency
	common.RedisEnabled = true
	common.SyncFrequency = 2
	common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() {
		_ = common.RDB.Close()
		common.RedisEnabled = oldRedisEnabled
		common.RDB = oldRDB
		common.SyncFrequency = oldSyncFrequency
	})
	return server
}

func TestUserAuthFenceRollbackExpiresAndRecovers(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	user := User{
		Username:    "auth-fence-rollback",
		Password:    "password",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))

	tx := DB.Begin()
	require.NoError(t, tx.Error)
	next, err := IncrementUserAuthVersionWithTx(tx, user.Id)
	require.NoError(t, err)
	assert.EqualValues(t, 2, next)

	_, err = cacheGetUserBase(user.Id)
	assert.ErrorIs(t, err, ErrUserAuthCachePending)
	cacheTTL, err := common.RDB.TTL(t.Context(), getUserCacheKey(user.Id)).Result()
	require.NoError(t, err)
	fenceTTL, err := common.RDB.TTL(t.Context(), getUserAuthFenceKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Greater(t, fenceTTL, cacheTTL)
	require.NoError(t, tx.Rollback().Error)

	server.FastForward(time.Duration(userAuthFenceTTLSeconds()+1) * time.Second)
	assert.False(t, server.Exists(getUserAuthFenceKey(user.Id)))
	committed, err := common.RDB.Get(t.Context(), getUserAuthVersionKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, "1", committed)

	cached, err := GetUserCache(user.Id)
	require.NoError(t, err)
	assert.EqualValues(t, 1, cached.AuthVersion)
}

func TestPendingUserAuthFenceRejectsStaleCacheWrite(t *testing.T) {
	server := useUserCacheMiniRedis(t)
	const userID = 4201
	require.NoError(t, SetUserAuthVersionFence(userID, 2))

	err := writeUserCache(&UserBase{
		Id: userID, Group: "default", Username: "stale", AuthVersion: 1,
	}, true)

	assert.ErrorIs(t, err, ErrUserAuthCachePending)
	assert.False(t, server.Exists(getUserCacheKey(userID)))
}

func TestUserAuthFieldUpdateRejectsVersionMismatch(t *testing.T) {
	useUserCacheMiniRedis(t)
	const userID = 4202
	require.NoError(t, writeUserCache(&UserBase{
		Id: userID, Group: "current", Username: "cached", AuthVersion: 3,
	}, true))

	err := updateUserCacheFieldAtVersion(userID, "Group", "stale", 2)

	assert.ErrorIs(t, err, ErrUserAuthCachePending)
	group, err := common.RDB.HGet(t.Context(), getUserCacheKey(userID), "Group").Result()
	require.NoError(t, err)
	assert.Equal(t, "current", group)
}

func TestRefreshUserGroupCacheRepairsDelayedSameVersionWrite(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	user := User{
		Username:    "delayed-group-refresh",
		Password:    "password",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))

	firstSnapshotRead := make(chan struct{})
	releaseDelayedRefresh := make(chan struct{})
	var intercepted atomic.Bool
	const callbackName = "test:block_delayed_group_refresh"
	require.NoError(t, DB.Callback().Query().After("gorm:query").Register(callbackName, func(*gorm.DB) {
		if intercepted.CompareAndSwap(false, true) {
			close(firstSnapshotRead)
			<-releaseDelayedRefresh
		}
	}))
	t.Cleanup(func() {
		_ = DB.Callback().Query().Remove(callbackName)
	})

	delayedResult := make(chan error, 1)
	go func() {
		delayedResult <- RefreshUserGroupCache(user.Id)
	}()
	<-firstSnapshotRead

	require.NoError(t, DB.Model(&User{}).Where("id = ?", user.Id).Update("group", "pro").Error)
	require.NoError(t, RefreshUserGroupCache(user.Id))
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, "pro", cached.Group)
	assert.EqualValues(t, 1, cached.AuthVersion)

	close(releaseDelayedRefresh)
	require.NoError(t, <-delayedResult)
	cached, err = cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, "pro", cached.Group)
	assert.EqualValues(t, 1, cached.AuthVersion)
}

func TestCommittedUserAuthVersionPermanentlyRejectsDelayedCacheFill(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	user := User{
		Username:    "auth-fence-commit",
		Password:    "password",
		Role:        common.RoleCommonUser,
		Status:      common.UserStatusEnabled,
		Group:       "default",
		AuthVersion: 1,
	}
	require.NoError(t, DB.Create(&user).Error)
	require.NoError(t, populateUserCache(user))
	stale := *user.ToBaseUser()

	require.NoError(t, DB.Transaction(func(tx *gorm.DB) error {
		_, err := IncrementUserAuthVersionWithTx(tx, user.Id)
		return err
	}))
	require.NoError(t, PublishUserAuthCache(user.Id))
	assert.False(t, server.Exists(getUserAuthFenceKey(user.Id)))
	committed, err := common.RDB.Get(t.Context(), getUserAuthVersionKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, "2", committed)

	server.FastForward(time.Duration(userAuthFenceTTLSeconds()+1) * time.Second)
	require.NoError(t, common.RedisDelKey(getUserCacheKey(user.Id)))
	err = writeUserCache(&stale, true)
	assert.True(t, errors.Is(err, ErrUserAuthCachePending))
	committed, err = common.RDB.Get(t.Context(), getUserAuthVersionKey(user.Id)).Result()
	require.NoError(t, err)
	assert.Equal(t, "2", committed)
}

func TestUserAuthVersionFenceAndCommittedFloorAreMonotonic(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	const userID = 4101
	require.NoError(t, SetUserAuthVersionFence(userID, 5))
	require.NoError(t, SetUserAuthVersionFence(userID, 3))
	pending, err := common.RDB.Get(t.Context(), getUserAuthFenceKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", pending)
	floor, err := getUserAuthVersionFloor(userID)
	require.NoError(t, err)
	assert.EqualValues(t, 5, floor)

	// Committing an older transaction must neither clear a newer pending fence
	// nor lower the effective deny floor.
	require.NoError(t, publishCommittedUserAuthVersion(userID, 3))
	pending, err = common.RDB.Get(t.Context(), getUserAuthFenceKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", pending)
	floor, err = getUserAuthVersionFloor(userID)
	require.NoError(t, err)
	assert.EqualValues(t, 5, floor)

	require.NoError(t, publishCommittedUserAuthVersion(userID, 5))
	assert.False(t, server.Exists(getUserAuthFenceKey(userID)))
	committed, err := common.RDB.Get(t.Context(), getUserAuthVersionKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", committed)

	require.NoError(t, publishCommittedUserAuthVersion(userID, 4))
	committed, err = common.RDB.Get(t.Context(), getUserAuthVersionKey(userID)).Result()
	require.NoError(t, err)
	assert.Equal(t, "5", committed)
}

// 鉴权中间件读的是 Redis 里的用户缓存，不是数据库行。缓存哈希漏写企业那三列时，
// UserBase.IsEnterprise 拿来是零值，EnterpriseAuth 就会给一个真打了标记的账号
// 返 403 —— 这正是「能进控制台页面、但 /api/enterprise/profile 报权限不足」的原因。
func TestUserCacheRoundTripsTheEnterpriseColumns(t *testing.T) {
	truncateTables(t)
	useUserCacheMiniRedis(t)

	enterprise := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 100)
	markEnterprise(t, enterprise.Id)
	// 两组白名单也走同一个哈希，漏写会让成员的限制静默失效（该收窄的没收窄）。
	require.NoError(t, DB.Model(&User{}).Where("id = ?", enterprise.Id).Updates(map[string]any{
		"enterprise_group_limits": `["vip"]`,
		"enterprise_model_limits": `["gpt-4o"]`,
	}).Error)

	// 取数据库里的权威快照，再让缓存从零重建一次。
	authoritative, err := GetUserById(enterprise.Id, false)
	require.NoError(t, err)
	require.NoError(t, populateUserCache(*authoritative))

	cached, err := cacheGetUserBase(enterprise.Id)
	require.NoError(t, err)
	assert.Equal(t, EnterpriseFlagYes, cached.IsEnterprise, "企业标记必须落进缓存哈希")
	assert.Equal(t, []string{"vip"}, cached.GetEnterpriseGroupLimits())
	assert.Equal(t, []string{"gpt-4o"}, cached.GetEnterpriseModelLimits())

	// 中间件真正依赖的那一步：标记写进上下文后必须放行。
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	cached.WriteContext(c)
	assert.True(t, common.GetContextKeyBool(c, constant.ContextKeyUserIsEnterprise),
		"缓存里的企业标记要能变成上下文里的通行证")

	// 没打标记的账号不能被缓存放行。
	plain := createEnterpriseUser(t, 2, "plain", common.RoleCommonUser, 0)
	require.NoError(t, populateUserCache(*plain))
	plainCached, err := cacheGetUserBase(plain.Id)
	require.NoError(t, err)
	assert.Equal(t, EnterpriseFlagNo, plainCached.IsEnterprise)
	plainCtx, _ := gin.CreateTestContext(httptest.NewRecorder())
	plainCached.WriteContext(plainCtx)
	assert.False(t, common.GetContextKeyBool(plainCtx, constant.ContextKeyUserIsEnterprise))
}

// 旧版本代码写下的哈希带着当时的版本号，字段却是缺的；版本号不比它更能说明问题。
// 这次字段集合变了就必须让那批条目失效，否则升级后仍会读到没有企业列的老条目。
func TestUserCacheRejectsEntriesFromThePreviousFieldSet(t *testing.T) {
	truncateTables(t)
	server := useUserCacheMiniRedis(t)

	user := createEnterpriseUser(t, 1, "corp", common.RoleCommonUser, 0)
	markEnterprise(t, user.Id)

	const cacheKey = "user:1"
	// 模拟旧代码写的哈希：字段齐全，但没有企业那三列，版本号是当年的 3。
	server.HSet(cacheKey, "Id", "1", "Group", "default", "Email", "",
		"Status", "1", "Role", "1", "Username", "corp", "Setting", "",
		"AuthVersion", "1", "CacheSchema", "3", "Quota", "0")

	_, err := cacheGetUserBase(user.Id)
	assert.Error(t, err, "字段集合变过的旧条目必须被拒绝，改从数据库重建")

	// 重建之后读到的就是补齐了的新条目。
	authoritative, err := GetUserById(user.Id, false)
	require.NoError(t, err)
	require.NoError(t, populateUserCache(*authoritative))
	cached, err := cacheGetUserBase(user.Id)
	require.NoError(t, err)
	assert.Equal(t, EnterpriseFlagYes, cached.IsEnterprise)
}
