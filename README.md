# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tungzu89/makefun-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tungzu89/makefun-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads a patch in one of
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls as JSON — finds the lines each
edit names at the first of three matching tiers, and changes every file or
none. See `SPEC.md` for the whole contract.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file, relative to the working directory;
when it is absent or `-`, the patch is read from standard input. The working
directory is the root of the tree of text files the patch edits.

Options:

- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one line per changed file (`A`, `D`, `M`, or `R` for a
move) and `ok: <n> files`, and exits 0. A patch whose edits fail prints one
`error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`,
and exits 1 without writing anything. A patch that cannot be read exits 2.

## Matching

An edit's old lines are found at the first tier where they occur at least
once: tier 0 is exact equality, tier 1 ignores trailing spaces and tabs,
tier 2 ignores leading and trailing spaces and tabs and re-indents the new
lines to the file's indentation. A unified hunk takes the occurrence nearest
its (possibly wrong) line number; a SEARCH/REPLACE block needs exactly one
occurrence; a V4A chunk takes the first occurrence at or after its cursor.

## Formats

- **Unified diff**: sections start at `diff --git` or a `---`/`+++` pair;
  hunks apply in order, each to the result of the ones before it. Creations,
  deletions and renames are all one edit per section.
- **SEARCH/REPLACE**: a block names its file on the nearest non-blank line
  before `<<<<<<< SEARCH`; an empty old block creates the file.
- **V4A**: sections between `*** Begin Patch` and `*** End Patch`; an update
  section walks its chunks with a cursor, honoring `@@` anchors and
  `*** End of File`.
- **JSON**: one array of edit objects, or one edit object per line
  (`create`, `str_replace`, `insert`), with exact matching for
  `str_replace` and CRLF preserved in CRLF files.

## Exit codes

| Exit | Meaning |
| ---- | ------- |
| 0 | Every edit applied; the tree is written. |
| 1 | Some edits failed; nothing is written. |
| 2 | Usage error, unreadable patch file, undetected format, or parse error. |

## Check it

The kit's practice set (100 checks with expected outcomes) runs locally:

```sh
node check.ts <practice.json>
```

Node 22 and its standard library only; nothing is installed.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mq03gnv1&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
