/** The guided build's three steps. Progress is stored on the strategy as 0-6
 *  (steps_completed), so drafts saved by older builds, clones (5) and
 *  submitted strategies (6) still read correctly: each step is done once the
 *  stored progress reaches its mark. */
export const STEPS = ["Audience", "Treatments", "Review & submit"] as const;
export const DONE_AT = [2, 4, 6];

/** How many of the three steps are done. */
export const stepsDone = (stored: number) => DONE_AT.filter((x) => stored >= x).length;
