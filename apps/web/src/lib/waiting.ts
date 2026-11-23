/** How long something has been waiting, in words (never only a colour or a number), for the team's queue. */
export interface Waited {
  hours: number;
  text: string;
}

export function waited(createdIso: string, now: number = Date.now()): Waited {
  const created = Date.parse(createdIso);
  // an unreadable date or a clock that is slightly behind never shows a negative wait
  const ms = Number.isNaN(created) ? 0 : Math.max(0, now - created);
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return { hours, text: "Waiting less than an hour" };
  if (hours < 48) return { hours, text: `Waiting ${hours} ${hours === 1 ? "hour" : "hours"}` };
  const days = Math.floor(hours / 24);
  return { hours, text: `Waiting ${days} days` };
}

/** A child-safety report that has waited a day or more is called out, so it is not lost in a long queue. */
export const SAFETY_ATTENTION_HOURS = 24;
