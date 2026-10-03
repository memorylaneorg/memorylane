# Collections Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Explicit Collections with photo/folder additions, browsing and optional TV sharing.
**Architecture:** Core collection IDs and explicit membership independent of AI/imported tags. Favorites reuses engagement. TV protocol presentation stays in the optional plugin.
**Tech Stack:** Existing SQLite, Fastify, React, TypeScript, Zod and plugin JavaScript.
**Spec:** docs/architecture/collections.md

## Global Constraints
- Originals remain read-only; core owns SQLite.
- No new dependency; MIT-compatible existing stack.
- Folder additions are snapshots, not saved folder rules.
- TV sharing is explicit and rechecked at delivery.
- Localized English/Spanish/French; validation on external storage.

## Review Focus
- Duplicate additions, overlapping folders and renames retain stable membership.
- Missing, marked, paired and disabled-source photos stay hidden.
- Collection deletion and share removal revoke aliases, even when another share grants the photo.
- Paged navigation and stale async responses must not mix collections.
- Existing TV settings without collections migrate to an empty selection.

### Task 1: Core collection data and authenticated API
**Files:** server/migrations/038_collections.sql, server/src/collections/collection-repo.ts, server/src/api/collections-routes.ts, server/src/app.ts, shared/src/types.ts, server/test/api/collections-routes.test.ts.
**Interfaces:** CollectionDto {id:number|string,name,count,builtin}; GET/POST collections, PATCH/DELETE numeric ID, GET :id/media, POST :id/members with mediaIds or folderId/recursive, DELETE :id/members with mediaIds. Favorites ID is 'favorites'.
- [x] Write tests for snapshots, deduplication, stable rename/delete, visibility and authentication; run and observe failure.
- [x] Implement migration, repository and validated routes using shared media predicates.
- [x] Run collection API and existing tag/favorite tests; expect all passing.

### Task 2: Collection interface
**Files:** client/src/api/client.ts, client/src/pages/CollectionsPage.tsx, client/src/components/CollectionPicker.tsx, FolderPage.tsx, Viewer.tsx, Layout.tsx, App.tsx, locale resources and component tests.
**Interfaces:** Consume Task 1 API; add selections/folder snapshots and viewer photo; browse/manage collections using existing grid/viewer.
- [x] Test adding folder snapshot and selected photos, error/retry and stale selection handling; observe failure.
- [x] Implement localized collection navigation, management, additions and removal.
- [x] Run client tests and typecheck; expect passing.

### Task 3: Optional TV collection sharing
**Files:** server/src/tv-sharing/broker.ts, shared/src/types.ts, TvSharingSettings.tsx, plugin module/catalog.mjs and associated tests.
**Interfaces:** settings collections array of stable IDs ('favorites' or numeric); tv.collections authorized list and membership pages; plugin collection aliases revalidated before image delivery.
- [x] Test collection-only sharing, favorite changes, rename, deletion, revoked aliases and backwards-compatible settings; observe failure.
- [x] Implement settings selection and broker policy; plugin adds flat root containers and aliases.
- [x] Run server/plugin/client relevant suites, typecheck and build. Review branch, document results and update ticket Discussion.

## Validation and decisions

- Used a feature branch in the existing external-disk checkout; no system-disk worktree.
- Dedicated collection membership acts as collection tags and avoids AI/imported-tag changes.
- Core/API and TV regression tests were observed failing before implementation, then passing.
- Full client tests, targeted server tests, plugin tests and workspace typechecks passed.
- Isolated browser testing covered creation, folder snapshots, rename, viewer additions,
  collection browsing and membership removal. Test catalog is in memory, temp files
  and client build on external storage, with no LAN sharing listener.
- Independent review found stale deleted sharing selections and unnecessary descriptor
  counts. Both reproduced with tests and fixed. No unresolved review findings.
- Real TV validation remains manual; the regular running service has not been replaced.
