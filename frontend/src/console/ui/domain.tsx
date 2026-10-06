import {
  Archive, Check, Copy, ExternalLink, GitBranch, Pause, Pencil, Play, Send, Trash2, Undo2,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, type LearningState, type ResultsState, type Strategy, type WaveRun } from "../lib/api";
import { num, pct, pp, SEGMENT_LABEL } from "../lib/format";
import { useSession } from "../lib/session";
import { Button, Chip, Field, Menu, Modal, inputCls, useAction, useToast, type MenuItem, type Tone } from "./ui";

export const SEGMENT_TONE: Record<string, Tone> = {
  Persuadable: "primary", "Sure Thing": "good", "Lost Cause": "warn", "Sleeping Dog": "neutral",
};

/** Where Thompson sampling stands. Exploring is normal, not a fault. */
export const LEARNING_TONE: Record<LearningState["state"], Tone> = {
  Settled: "good", Leaning: "info", Exploring: "neutral", "Not started": "neutral", "Single treatment": "neutral",
  "No treatments": "neutral",
};

/** A strategy's result against its own control group. */
export const RESULT_TONE: Record<ResultsState["state"], Tone> = {
  Proven: "good", "Worse than control": "bad", "Not proven yet": "neutral", "No results": "neutral",
};

/** Intervention-fit group, labelled honestly. The four quadrant names describe
 *  a treated-vs-untreated contrast a single score cannot measure, so the UI
 *  says what the score actually estimates and keeps the quadrant name as a hint. */
export const SegmentChip = ({ segment }: { segment: string }) => (
  <Chip title={`Quadrant: ${segment} (provisional until the uplift model)`}>
    {SEGMENT_LABEL[segment] ?? segment}
  </Chip>
);

/** Rate + uplift over control in one cell. */
export function ResultCell({ rate, uplift, significant, underpowered }: {
  rate: number | null | undefined; uplift: number | null | undefined; significant?: boolean; underpowered?: boolean;
}) {
  if (rate === null || rate === undefined) return <span className="text-fg-3">—</span>;
  return (
    <span className="num inline-flex flex-col leading-tight">
      <span className="font-medium text-fg">{pct(rate)}</span>
      <span className={uplift === null || uplift === undefined ? "text-2xs text-fg-3"
        : significant ? (uplift > 0 ? "text-2xs text-good" : "text-2xs text-bad") : "text-2xs text-fg-3"}
        title={underpowered ? "Smaller than this sample can reliably detect" : undefined}>
        {uplift === null || uplift === undefined ? "no control yet" : `${pp(uplift)} vs control${significant ? "" : " · not sig."}`}
      </span>
    </span>
  );
}

type Confirm = null | "approve" | "reject" | "revise" | "delete" | "archive";

/** Why delete is refused, in the user's terms. Mirrors the API rule. */
function deleteBlocked(s: Strategy): string | undefined {
  if (s.deletable) return undefined;
  if (s.has_history) return "It has decided customers. Its results are evidence, so archive it instead.";
  if (s.status === "Live") return "Pause it first.";
  return "Not allowed for this strategy.";
}

/** The lifecycle actions a strategy offers to the current user, and nothing else.
 *  Primary actions are buttons; everything else sits in the More menu. */
export function StrategyActions({ s, onChange, compact, onDeleted }: {
  s: Strategy; onChange: () => void; compact?: boolean; onDeleted?: () => void;
}) {
  const { can, me } = useSession();
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const [modal, setModal] = useState<Confirm>(null);
  const [note, setNote] = useState("");
  const size = compact ? "sm" : "md";
  const id = s.campaign_id;
  const mine = me?.user.user_id === s.created_by || me?.user.user_id === s.owner_id;
  const close = () => { setModal(null); setNote(""); };
  const act = (k: string, path: string, ok: string, body?: unknown) =>
    run(k, () => api.post(path, body), ok).then((r) => { if (r !== undefined) onChange(); return r; });

  const canEdit = can("edit_strategy") && (s.editable || s.revisable) && s.status !== "Archived";
  const nextVersion = s.version + 1;
  const edit = () => {
    if (s.open_revision) navigate(`/builder/${s.open_revision}`);
    else if (s.revisable) setModal("revise");
    else navigate(`/builder/${id}`);
  };
  const editLabel = s.open_revision ? `Continue v${nextVersion} draft` : "Edit";
  const clone = () => run("clone", () => api.post<Strategy>(`/strategies/${id}/clone`), (r) => `Cloned into ${r.campaign_id}.`)
    .then((r) => r && navigate(`/builder/${r.campaign_id}`));

  const items: MenuItem[] = [
    { label: editLabel, icon: <Pencil className="h-3.5 w-3.5" />, onClick: edit, hidden: !compact || !canEdit },
    { label: "View details", icon: <ExternalLink className="h-3.5 w-3.5" />, onClick: () => navigate(`/strategies/${id}`), hidden: !compact },
    { label: "Clone as a new draft", icon: <Copy className="h-3.5 w-3.5" />, onClick: clone, hidden: !can("create_strategy") },
    { label: "Archive", icon: <Archive className="h-3.5 w-3.5" />, onClick: () => setModal("archive"),
      hidden: !can("pause_archive_strategy") || s.status === "Archived",
      disabled: s.status === "Live", reason: "Pause it first." },
    { label: "Delete", icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onClick: () => setModal("delete"),
      hidden: !can("create_strategy"), disabled: !s.deletable, reason: deleteBlocked(s) },
  ];

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {!compact && canEdit && (
        <Button size={size} variant="secondary" icon={s.open_revision ? <GitBranch className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
          loading={busy === "revise"} onClick={edit}>{editLabel}</Button>
      )}
      {can("edit_strategy") && s.status === "Draft" && (
        <Button size={size} variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={busy === "submit"}
          onClick={() => act("submit", `/strategies/${id}/submit`, `${id} submitted for approval.`)}>Submit</Button>
      )}
      {can("approve_strategy") && s.status === "In review" && (
        mine ? <Chip tone="warn" title="Maker-checker">You authored this - another approver is needed</Chip> : (
          <>
            <Button size={size} variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => setModal("approve")}>Approve</Button>
            <Button size={size} variant="secondary" icon={<Undo2 className="h-3.5 w-3.5" />} onClick={() => setModal("reject")}>Return</Button>
          </>
        )
      )}
      {can("launch_strategy") && ["Approved", "Paused"].includes(s.status) && (
        <Button size={size} variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={busy === "launch"}
          onClick={() => act("launch", `/strategies/${id}/launch`,
            s.parent_id && s.status === "Approved" ? `${id} v${s.version} is live. ${s.parent_id} has been archived.` : `${id} is live.`)}>
          {s.status === "Paused" ? "Resume" : "Launch"}
        </Button>
      )}
      {can("pause_archive_strategy") && s.status === "Live" && (
        <Button size={size} icon={<Pause className="h-3.5 w-3.5" />} loading={busy === "pause"}
          onClick={() => act("pause", `/strategies/${id}/pause`, `${id} paused.`)}>Pause</Button>
      )}
      <Menu items={items} size={size} label={`More actions for ${id}`} />

      <Modal open={modal === "approve" || modal === "reject"} onClose={close}
        title={modal === "approve" ? `Approve ${id}` : `Return ${id} to draft`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={modal === "reject" && !note.trim()} loading={busy === modal}
            onClick={() => act(modal!, `/strategies/${id}/${modal === "approve" ? "approve" : "reject"}`,
              modal === "approve" ? `${id} approved. The owner can launch it.` : `${id} returned to ${s.owner}.`,
              { note }).then(close)}>
            {modal === "approve" ? "Approve" : "Return to draft"}
          </Button>
        </>}>
        <p className="mb-3 text-[13px] text-fg-2">
          {modal === "approve"
            ? `${s.name} (v${s.version}) by ${s.owner}. Approval lets the owner launch it against live accounts.${s.parent_id ? ` Launching it will archive ${s.parent_id}, the version it replaces.` : ""} It is recorded against your name.`
            : "Say what needs to change. The note goes to the author and into the audit log."}
        </p>
        <Field label={modal === "approve" ? "Note (optional)" : "What needs to change"} required={modal === "reject"}>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputCls} h-auto py-2`} />
        </Field>
      </Modal>

      <Modal open={modal === "revise"} onClose={close} title={`Edit ${s.name}`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<GitBranch className="h-3.5 w-3.5" />} loading={busy === "revise"}
            onClick={() => run("revise", () => api.post<Strategy>(`/strategies/${id}/revise`),
              (r) => r.created ? `Opened ${r.campaign_id} as v${r.version} of ${id}.` : `Continuing ${r.campaign_id}.`)
              .then((r) => { close(); if (r) navigate(`/builder/${r.campaign_id}`); })}>Create v{nextVersion} draft</Button>
        </>}>
        <div className="space-y-2.5 text-[13px] leading-5 text-fg-2">
          <p>{id} has already decided {num(s.stats?.decisions ?? 0)} customers, so it is not changed in place. Your changes go into <span className="font-medium text-fg">version {nextVersion}</span>, a new draft.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{id} v{s.version} keeps running exactly as approved until v{nextVersion} is approved and launched.</li>
            <li>Launching v{nextVersion} archives v{s.version}. Customers already in v{s.version} stay with it.</li>
            <li>v{nextVersion} gets its own control group, and its learning starts fresh from the playbook.</li>
          </ul>
        </div>
      </Modal>

      <Modal open={modal === "delete"} onClose={close} title={`Delete ${id}?`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} loading={busy === "delete"}
            onClick={() => run("delete", () => api.del(`/strategies/${id}`), `${id} deleted.`)
              .then((r) => { close(); if (r) (onDeleted ?? onChange)(); })}>Delete strategy</Button>
        </>}>
        <p className="text-[13px] leading-5 text-fg-2">
          {s.name} ({s.status.toLowerCase()}) has never decided a customer, so nothing else depends on it. It is removed permanently; the audit log keeps a record that it existed and who deleted it.
        </p>
      </Modal>

      <Modal open={modal === "archive"} onClose={close} title={`Archive ${id}?`}
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<Archive className="h-3.5 w-3.5" />} loading={busy === "archive"}
            onClick={() => act("archive", `/strategies/${id}/archive`, `${id} archived.`).then(close)}>Archive</Button>
        </>}>
        <p className="text-[13px] leading-5 text-fg-2">
          Archived strategies stop deciding and cannot be resumed. Their decisions and results stay in every report. To run it again, clone it into a new draft.
        </p>
      </Modal>
    </div>
  );
}

/** One line for a wave run: what was decided, and where the customers came from. */
export function waveMessage(r: WaveRun, names: Record<string, string>): string {
  if (!r.waves_run) return r.message ?? "No customers to decide.";
  const which = r.waves_run > 1 ? `Waves ${r.first_wave}-${r.wave}` : `Wave ${r.wave}`;
  const arms = Object.entries(r.by_treatment).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${names[c] ?? c} ${n}`).join(", ");
  const added = r.handoffs.reduce((n, h) => n + h.total, 0);
  return `${which}: ${num(r.decided)} decided, ${num(r.control)} to control.`
    + (arms ? ` Treated: ${arms}.` : "")
    + (r.held_for_review ? ` ${r.held_for_review} held for review.` : "")
    + (r.blocked_by_guard ? ` ${r.blocked_by_guard} stopped by the contact guard.` : "")
    + (added ? ` The audience was running out, so ${r.handoffs.length === 1 ? "a new cohort handoff" : `${r.handoffs.length} handoffs`} arrived automatically (+${num(added)} accounts).` : "");
}

/** Run the next wave, or five in a row. Learning updates between waves. */
export function WaveButton({ s, onDone, size = "md" }: { s: Strategy; onDone: (r: WaveRun) => void; size?: "sm" | "md" }) {
  const { can, refresh } = useSession();
  const { run, busy } = useAction();
  const toast = useToast();
  if (s.status !== "Live" || !can("launch_strategy")) return null;
  const names = Object.fromEntries(s.treatments.map((t) => [t.code, t.name]));
  const go = (n: number) => run(`w${n}`, () => api.post<WaveRun>(`/strategies/${s.campaign_id}/waves?count=${n}`)).then((r) => {
    if (!r) return;
    toast(r.waves_run ? "good" : "info", waveMessage(r, names));
    onDone(r);
    refresh();
  });
  return (
    <div className="inline-flex items-center gap-1">
      <Button size={size} variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={busy === "w1"} disabled={busy === "w5"}
        onClick={() => go(1)}>Run next wave</Button>
      <Button size={size} variant="secondary" loading={busy === "w5"} disabled={busy === "w1"} onClick={() => go(5)}
        title="Run five waves in a row. Beliefs update after each one.">Run 5</Button>
    </div>
  );
}
