/** The process holding a claim: the host it runs on and its process id. */
export interface ClaimHolder {
    host: string;
    pid: number;
}
/** Checks whether claim holders are still running. Supplied by the CLI; absent in tests by default. */
export interface ProcessProbe {
    /**
     * This process, recorded on the claims it makes. Set only for a process that lives as long as
     * the agent session (the MCP server); a short CLI command would look dead the moment it ends.
     */
    self?: ClaimHolder;
    /**
     * True while the holder runs, false once it has exited, null when this machine cannot tell
     * (another host, or the check failed). Only false counts as proof that the holder is gone.
     */
    alive(holder: ClaimHolder): boolean | null;
}
