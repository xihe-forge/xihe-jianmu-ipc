# PR 模板

> 复制本文件到 `.github/pull_request_template.md`

---

```markdown
## Summary

<!-- 1-3 个要点说明做了什么 -->

-
-

## Related Issues

<!-- 关联的 Issue 编号 -->

Closes #

## Changes

<!-- 详细描述变更内容 -->

### 新增

-

### 修改

-

### 删除

-

## Test Plan

<!-- 怎么验证这个变更是正确的 -->

- [ ]
- [ ]

## Screenshots

<!-- 如果涉及 UI 变更，附截图 -->

## Checklist

- [ ] 代码通过 `cargo fmt --check`
- [ ] 代码通过 `cargo clippy -- -D warnings`
- [ ] 代码通过 `vue-tsc --noEmit`
- [ ] 新功能有对应测试
- [ ] 文档已更新（如需要）
- [ ] CLAUDE.md 已更新（如需要）
- [ ] 没有引入新的 `console.log`
- [ ] 没有硬编码的密钥或 Token
```
