// Anything credential-shaped that must never land in a committed fixture: a
// PEM, a JWT, or a GitHub token (installation `ghs_`, OAuth/user `gho_`/`ghu_`,
// classic `ghp_`, refresh `ghr_`, fine-grained `github_pat_`) — except the
// all-`x` placeholder capture.ts writes in place of the real token. Shared by
// capture.ts (refuses to write) and github.test.ts (fails on a committed leak).
export const CREDENTIAL = /-----BEGIN|eyJ[A-Za-z0-9_-]{10,}|\bgh[opsur]_(?!x+\b)[A-Za-z0-9_]{8,}|github_pat_/;
