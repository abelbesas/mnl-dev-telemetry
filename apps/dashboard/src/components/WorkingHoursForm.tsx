"use client";

import { useActionState } from "react";
import { useToastOnResult } from "@/components/Toaster";

export interface SettingsState {
  ok?: boolean;
  message?: string;
}

/** Working-hours editor with toast confirmation (spec §4.5 Settings). */
export function WorkingHoursForm({
  action,
  timezones,
  tz,
  workdayStart,
  workdayEnd,
}: {
  action: (state: SettingsState, formData: FormData) => Promise<SettingsState>;
  timezones: string[];
  tz: string;
  workdayStart: string;
  workdayEnd: string;
}) {
  const [state, formAction, pending] = useActionState<SettingsState, FormData>(
    action,
    {},
  );
  useToastOnResult(state);

  return (
    <form action={formAction}>
      <label className="field">
        <span>Timezone</span>
        <select name="tz" defaultValue={tz}>
          {timezones.includes(tz) ? null : <option value={tz}>{tz}</option>}
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label className="field">
          <span>Start</span>
          <input type="time" name="workdayStart" defaultValue={workdayStart} />
        </label>
        <label className="field">
          <span>End</span>
          <input type="time" name="workdayEnd" defaultValue={workdayEnd} />
        </label>
      </div>
      <button className="btn" type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save working hours"}
      </button>
      <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.6rem" }}>
        Re-runs of the stitcher will clamp your sessions to this window (Mon–Fri).
      </p>
    </form>
  );
}
