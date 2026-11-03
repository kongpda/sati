/** Shared flags. Lists are comma-separated because citty keeps only the last repeated flag. */
export const json = {
  json: { type: "boolean", description: "Print JSON for scripts and agents" },
} as const;

export const expectedVersion = {
  "expected-version": {
    type: "string",
    description: "Fail with CONFLICT unless the record is at this version",
  },
} as const;

export const pagination = {
  limit: { type: "string", description: "Max results (default 50, max 500)" },
  offset: { type: "string", description: "Skip this many results" },
} as const;

export const id = (what: string) =>
  ({
    id: { type: "positional", required: true, description: `${what} id or short handle` },
  }) as const;
