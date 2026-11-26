package model

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"math"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/setting/operation_setting"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	MaxCanvasObjectBytes    = 32 * 1024 * 1024
	MaxCanvasCollectionKeys = 10000
)

var (
	ErrCanvasTokenDeleted         = errors.New("canvas API key was deleted; explicitly create a replacement to continue")
	ErrCanvasTokenNotDeleted      = errors.New("canvas API key still exists; manage it in API key settings")
	ErrCanvasTokenDisabled        = errors.New("canvas API key is disabled; enable it in API key settings")
	ErrCanvasTokenExpired         = errors.New("canvas API key has expired; update it in API key settings")
	ErrCanvasTokenExhausted       = errors.New("canvas API key quota is exhausted; update it in API key settings")
	ErrCanvasTokenGroup           = errors.New("canvas API key must use the auto group; update it in API key settings")
	ErrCanvasTokenLimit           = errors.New("API key limit reached; remove an unused key before opening the canvas")
	ErrCanvasAutoUnavailable      = errors.New("no permitted auto groups are available for the canvas")
	ErrCanvasObjectTooLarge       = errors.New("canvas object exceeds the 32 MiB limit")
	ErrCanvasCollectionTooLarge   = errors.New("canvas collection exceeds the 10000 key listing limit")
	ErrCanvasStorageQuotaExceeded = errors.New("canvas storage limit reached; delete unused canvas assets or projects to free space")
	ErrCanvasStorageConflict      = errors.New("canvas chat changed; reload it before retrying")
)

// CanvasAccount survives token deletion so reopening the canvas cannot silently
// undo a user's decision to revoke its credential. TokenID is zero until the
// first bootstrap; cloud storage can be used without provisioning a credential.
type CanvasAccount struct {
	UserID  int `gorm:"primaryKey;autoIncrement:false"`
	TokenID int `gorm:"not null"`
}

// CanvasObject keeps the upstream storage keys and payloads unchanged. A digest
// provides case-sensitive identity without depending on a database collation or
// putting long, user-controlled strings in a composite index.
type CanvasObject struct {
	ID          int    `gorm:"primaryKey"`
	UserID      int    `gorm:"not null;uniqueIndex:idx_canvas_object_owner_hash,priority:1;index:idx_canvas_object_collection,priority:1"`
	ObjectHash  string `gorm:"type:varchar(64);not null;uniqueIndex:idx_canvas_object_owner_hash,priority:2"`
	Collection  string `gorm:"type:varchar(32);not null;index:idx_canvas_object_collection,priority:2"`
	RecordKey   string `gorm:"type:text;not null"`
	Data        []byte `gorm:"size:33554432;not null"`
	ContentType string `gorm:"type:varchar(255);not null"`
	UpdatedAt   int64  `gorm:"type:bigint;not null"`
}

// EnsureCanvasToken commits the binding and credential together. The initial
// upsert obtains a write lock even on SQLite before any reads, so concurrent
// first opens cannot both reserve a token or leave an orphan credential.
func EnsureCanvasToken(ctx context.Context, userID int, defaultAutoGroupsAvailable, replaceDeleted bool) (*Token, bool, error) {
	var token Token
	created := false
	err := DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		account, err := lockCanvasAccount(tx, userID)
		if err != nil {
			return err
		}
		if account.TokenID != 0 {
			err := tx.Where("id = ? AND user_id = ?", account.TokenID, userID).First(&token).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			if err == nil {
				if replaceDeleted {
					return ErrCanvasTokenNotDeleted
				}
				switch token.Status {
				case common.TokenStatusExpired:
					return ErrCanvasTokenExpired
				case common.TokenStatusExhausted:
					return ErrCanvasTokenExhausted
				case common.TokenStatusEnabled:
				default:
					return ErrCanvasTokenDisabled
				}
				if token.ExpiredTime != -1 && token.ExpiredTime <= common.GetTimestamp() {
					return ErrCanvasTokenExpired
				}
				if !token.UnlimitedQuota && token.RemainQuota <= 0 {
					return ErrCanvasTokenExhausted
				}
				if token.Group != "auto" {
					return ErrCanvasTokenGroup
				}
				return nil
			}
			if !replaceDeleted {
				return ErrCanvasTokenDeleted
			}
		} else if replaceDeleted {
			return ErrCanvasTokenNotDeleted
		}
		if !defaultAutoGroupsAvailable {
			return ErrCanvasAutoUnavailable
		}
		var count int64
		if err := tx.Model(&Token{}).Where("user_id = ?", userID).Count(&count).Error; err != nil {
			return err
		}
		if count >= int64(operation_setting.GetMaxUserTokens()) {
			return ErrCanvasTokenLimit
		}
		key, err := common.GenerateKey()
		if err != nil {
			return err
		}
		token = Token{
			UserId: userID, Key: key, Name: "Infinite Canvas", Status: common.TokenStatusEnabled,
			CreatedTime: common.GetTimestamp(), AccessedTime: common.GetTimestamp(),
			ExpiredTime: -1, UnlimitedQuota: true, Group: "auto",
		}
		if err := tx.Create(&token).Error; err != nil {
			return err
		}
		if err := tx.Model(account).Update("token_id", token.Id).Error; err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return &token, created, nil
}

// lockCanvasAccount serializes credential provisioning and collection growth
// for one owner. The write precedes reads to avoid SQLite read-to-write races.
func lockCanvasAccount(tx *gorm.DB, userID int) (*CanvasAccount, error) {
	account := CanvasAccount{UserID: userID}
	if err := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}}, DoNothing: true}).Create(&account).Error; err != nil {
		return nil, err
	}
	err := lockForUpdate(tx).First(&account, "user_id = ?", userID).Error
	return &account, err
}

func canvasObjectHash(collection, key string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(collection+"\x00"+key)))
}

func ListCanvasObjectKeys(ctx context.Context, userID int, collection string) ([]string, error) {
	keys := make([]string, 0)
	err := DB.WithContext(ctx).Model(&CanvasObject{}).Where("user_id = ? AND collection = ?", userID, collection).
		Order("id").Limit(MaxCanvasCollectionKeys+1).Pluck("record_key", &keys).Error
	if err != nil {
		return nil, err
	}
	if len(keys) > MaxCanvasCollectionKeys {
		return nil, ErrCanvasCollectionTooLarge
	}
	return keys, nil
}

func GetCanvasObject(ctx context.Context, userID int, collection, key string) (*CanvasObject, error) {
	var object CanvasObject
	err := DB.WithContext(ctx).Where("user_id = ? AND object_hash = ?", userID, canvasObjectHash(collection, key)).First(&object).Error
	return &object, err
}

// expectedHash is nil for an unconditional write, "absent" for create-only,
// or the SHA256 of the previously read payload for a conditional replacement.
func PutCanvasObject(ctx context.Context, object *CanvasObject, expectedHash *string) error {
	if len(object.Data) > MaxCanvasObjectBytes {
		return ErrCanvasObjectTooLarge
	}
	object.ObjectHash = canvasObjectHash(object.Collection, object.RecordKey)
	object.UpdatedAt = common.GetTimestamp()
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if _, err := lockCanvasAccount(tx, object.UserID); err != nil {
			return err
		}
		var existing struct {
			ID          int
			StoredBytes int64
			Data        []byte
		}
		query := tx.Model(&CanvasObject{}).Select("id, LENGTH(data) AS stored_bytes")
		if expectedHash != nil && *expectedHash != "absent" {
			query = query.Select("id, LENGTH(data) AS stored_bytes, data")
		}
		err := query.Where("user_id = ? AND object_hash = ?", object.UserID, object.ObjectHash).First(&existing).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if expectedHash != nil {
			if *expectedHash == "absent" {
				if err == nil {
					return ErrCanvasStorageConflict
				}
			} else if err != nil || fmt.Sprintf("%x", sha256.Sum256(existing.Data)) != *expectedHash {
				return ErrCanvasStorageConflict
			}
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			var count int64
			if err := tx.Model(&CanvasObject{}).Where("user_id = ? AND collection = ?", object.UserID, object.Collection).Count(&count).Error; err != nil {
				return err
			}
			if count >= MaxCanvasCollectionKeys {
				return ErrCanvasCollectionTooLarge
			}
		}
		// A lower configured limit must still let users reduce existing data.
		// Compare net growth while holding the owner lock, across all collections.
		growth := int64(len(object.Data)) - existing.StoredBytes
		if growth > 0 {
			limitMB := common.GetEnvOrDefault("CANVAS_STORAGE_LIMIT_MB", 512)
			if limitMB <= 0 || int64(limitMB) > math.MaxInt64/(1024*1024) {
				limitMB = 512
			}
			limitBytes := int64(limitMB) * 1024 * 1024
			var usedBytes int64
			if err := tx.Model(&CanvasObject{}).Where("user_id = ?", object.UserID).Select("COALESCE(SUM(LENGTH(data)), 0)").Scan(&usedBytes).Error; err != nil {
				return err
			}
			if growth > limitBytes-usedBytes {
				return ErrCanvasStorageQuotaExceeded
			}
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}, {Name: "object_hash"}},
			DoUpdates: clause.AssignmentColumns([]string{"data", "content_type", "updated_at"}),
		}).Create(object).Error
	})
}

func DeleteCanvasObjects(ctx context.Context, userID int, collection, key string) error {
	return DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Deletion must share the write lock: removing an object between an
		// overwrite's size read and total scan would undercount its net growth.
		if _, err := lockCanvasAccount(tx, userID); err != nil {
			return err
		}
		query := tx.Where("user_id = ? AND collection = ?", userID, collection)
		if key != "" {
			query = query.Where("object_hash = ?", canvasObjectHash(collection, key))
		}
		return query.Delete(&CanvasObject{}).Error
	})
}
