// A record id that names one file directly inside its store's directory: it starts with a letter or digit and holds
// only letters, digits, dots, underscores and hyphens, so it can't climb out with `..`, reach into a folder with `/`,
// or name a reserved `_`-prefixed collection. Every file store checks an id with this before joining it into a path.
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSafeRecordId(id: string): boolean {
  return SAFE_RECORD_ID.test(id)
}
