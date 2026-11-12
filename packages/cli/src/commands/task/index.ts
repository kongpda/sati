import { defineCommand } from "citty";
import { claimCommand, releaseCommand, takeOverCommand } from "./claim.js";
import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { removeCommand, restoreCommand } from "./remove.js";
import { approveCommand, completeCommand, sendBackCommand } from "./review.js";
import { showCommand } from "./show.js";
import { checklistCommand, updateCommand } from "./update.js";

export default defineCommand({
  meta: { name: "task", description: "Create, list and finish tasks" },
  subCommands: {
    create: createCommand,
    list: listCommand,
    show: showCommand,
    update: updateCommand,
    checklist: checklistCommand,
    claim: claimCommand,
    approve: approveCommand,
    "send-back": sendBackCommand,
    release: releaseCommand,
    "take-over": takeOverCommand,
    complete: completeCommand,
    delete: removeCommand,
    restore: restoreCommand,
  },
});
