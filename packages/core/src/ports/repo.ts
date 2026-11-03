/** One tracked file as git's index sees it (`git ls-files -s`): no file contents are read. */
export interface RepoFile {
  path: string;
  /** The blob hash git stores for the staged content. */
  blob: string;
}

/** Read-only view of the git repository, supplied by the CLI. Absent outside a git repo. */
export interface RepoIndex {
  files(): Promise<RepoFile[]>;
  /** The commit HEAD points at, or null in a repo without commits. */
  head(): Promise<string | null>;
}
