package model

import (
	"fmt"

	"gorm.io/gorm"
)

// migrateInviteRebateGrantUniqueness 把邀请返现台账的唯一索引从
// (source, source_ref) 换成 (source, source_ref, inviter_id)。
//
// 起因是一笔充值现在可能发出两条腿、落到两个不同的人头上。旧的唯一索引只按
// 来源去重，第二条腿会因为「这笔充值已经发过」被直接挡掉——不是报错，是整条
// 腿静默丢失，账面上看不出任何异常。
//
// 必须在 AutoMigrate 之前跑：AutoMigrate 只按索引名判断存不存在，不会发现同名
// 索引的列变了，也不会删掉它不认识的多余索引。带着旧索引进 AutoMigrate，新索引
// 建得出来，旧索引却会一直留在表上继续挡第二条腿。
//
// 这里按索引名而不是按定义匹配，与 token / prefill_group 那两处迁移不同：
// invite_rebates 这张表以及它上面唯一的那个索引都是本项目自己建的，名字从第一天
// 起就是 idx_invite_rebate_source，不存在「别处导入的库里索引叫别的名字」这种情况。
// 迁移是幂等的：新索引一旦存在就直接返回，重复启动不会反复删建。
//
// leg 列由 AutoMigrate 在这之后补上，它的 default 会把存量行回填成 direct
// （老台账只有直属下线这一条腿），因此这里不需要额外的数据迁移。
func migrateInviteRebateGrantUniqueness(db *gorm.DB) error {
	if db == nil {
		return fmt.Errorf("migrate invite rebate grant uniqueness: database is nil")
	}
	migrator := db.Migrator()
	if !migrator.HasTable(&InviteRebate{}) {
		return nil
	}
	if migrator.HasIndex(&InviteRebate{}, inviteRebateGrantIndex) {
		return nil
	}
	if !migrator.HasIndex(&InviteRebate{}, legacyInviteRebateSourceIndex) {
		// 全新库或已经被换过的库：交给 AutoMigrate 按模型建索引。
		return nil
	}
	if err := migrator.DropIndex(&InviteRebate{}, legacyInviteRebateSourceIndex); err != nil {
		return fmt.Errorf("drop legacy invite rebate uniqueness index %q: %w", legacyInviteRebateSourceIndex, err)
	}
	return nil
}

// 关于 users.first_topup_at：旧的首充返现规则靠它判定，规则取消后已经没有任何
// 读取方（User 上的字段与打点写入一并删掉了），但它**故意留在库里**。
//
// 不删的原因有两个，都不是洁癖层面的：
//
//  1. SQLite 没有原生的 DROP COLUMN，驱动是「建新表 → 拷数据 → 删旧表 → 改名」
//     重建整张 users 表，并且不会把索引一起搬过去——表上十几个索引要等到紧随
//     其后的 AutoMigrate 才补回来。为一个没人读的列去重建全站最核心的表不划算。
//  2. 列里存的是「这个用户第一次成功充值是什么时候」，是真实的历史业务数据。
//     首充转化率这类问题以后可能还要回头看，删掉就再也拿不回来了。
//
// 代价是升级过的库比全新装的库多一列（可空、默认 0、无人读写）。这个差异是
// 良性的：新装的库没有这一列，也不会有任何代码去碰它。
