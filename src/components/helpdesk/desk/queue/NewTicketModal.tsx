"use client";

// "New ticket" (the queue's + button): an agent raises a ticket on
// someone's behalf (a phone call, a hallway question). POST
// /api/helpdesk/tickets; the new ticket opens in the pane.

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Button, iconButtonClass } from "@/components/Button";
import { EntityPicker } from "@/components/EntityPicker";
import { Field, FormError, Select, TextInput, Textarea } from "@/components/form";
import { HD_PRIORITIES, HD_PRIORITY_LABEL, type HdPriority, type HdTicket } from "@/lib/helpdesk/types";
import { itemOf, sendJson } from "../api";
import { useDeskCounts } from "../counts";
import { personOption, usePeople } from "../people";

export function NewTicketModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (number: number) => void }) {
  const titleId = useId();
  const people = usePeople();
  const { counts } = useDeskCounts();
  const [requester, setRequester] = useState<number | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [team, setTeam] = useState<string>("");
  const [priority, setPriority] = useState<HdPriority>("normal");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setRequester(null);
      setSubject("");
      setBody("");
      setTeam("");
      setPriority("normal");
      setTried(false);
      setError("");
    }
  }, [open]);

  const who = people?.find((p) => p.id === requester);
  const errs = {
    requester: !requester ? "Choose who the ticket is for." : undefined,
    subject: !subject.trim() ? "Give the ticket a subject." : undefined,
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (errs.requester || errs.subject) return;
    setBusy(true);
    setError("");
    try {
      const d = await sendJson(
        "/api/helpdesk/tickets",
        "POST",
        { requester_id: requester, subject: subject.trim(), body: body.trim(), team_id: team ? Number(team) : null, priority },
        "Couldn't create the ticket."
      );
      const t = itemOf<HdTicket>(d, "ticket");
      onCreated(t.number);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="w-full max-w-lg rounded-xl border border-slate-200 bg-surface p-5 shadow-modal">
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            New ticket
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-tt="Close" className={iconButtonClass("quiet", "sm", "-mr-1 -mt-1")}>
            <X aria-hidden />
          </button>
        </div>
        <p className="mt-1 text-sm text-slate-600">Raise a ticket for someone who called or stopped by. They get the usual confirmation email.</p>
        <div className="mt-4 space-y-3">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Requester</p>
            {who ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="truncate font-medium text-slate-800">{who.name || who.username}</span>
                <button type="button" className="link text-xs" onClick={() => setRequester(null)}>
                  Change
                </button>
              </div>
            ) : (
              <EntityPicker
                options={(people ?? []).map(personOption)}
                onPick={(id) => setRequester(id)}
                label="Requester"
                placeholder="Search people…"
              />
            )}
            {tried && errs.requester && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {errs.requester}
              </p>
            )}
          </div>
          <Field label="Subject" error={tried ? errs.subject : undefined}>
            <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
          </Field>
          <Field label="What they need (optional)">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-28" maxLength={20000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Team">
              <Select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">Decide by the rules</option>
                {counts?.teams.map((t) => (
                  <option key={t.team_id} value={t.team_id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value as HdPriority)}>
                {HD_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {HD_PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <FormError>{error}</FormError>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create ticket
          </Button>
        </div>
      </form>
    </Modal>
  );
}
