// TODO: refactor onto @fujocoded/astro-smooth-action once it's officially out.
// Drops cleanRedirect / redirectWithStatus / isPermissionError / redirectUrl return shape:
// throw ActionError for failures, return { status, eventName }, let middleware do PRG via
// session storage. Also remove the `redirect` form field and the `?rsvp=&event=` query-param
// channel in events.astro + EventCard.astro.

import { defineAction } from "astro:actions";
import { z } from "astro/zod";
import { AtUri } from "@atproto/api";

import {
  RSVP_STATUS_GOING,
  RSVP_STATUS_NOT_GOING,
  setRsvpStatus,
  type RsvpStatus,
} from "../lib/rsvps";

const EVENT_COLLECTION = "community.lexicon.calendar.event";

function isValidEventUri(uri: string): boolean {
  try {
    const parsed = new AtUri(uri);
    return (
      parsed.host.startsWith("did:") &&
      parsed.collection === EVENT_COLLECTION &&
      parsed.rkey.length > 0
    );
  } catch {
    return false;
  }
}

const FORM_STATUS_TO_RSVP_STATUS: Record<"going" | "notgoing", RsvpStatus> = {
  going: RSVP_STATUS_GOING,
  notgoing: RSVP_STATUS_NOT_GOING,
};

function redirectWithStatus(status: string): string {
  return `/events?rsvp=${encodeURIComponent(status)}`;
}

function isPermissionError(error: unknown): boolean {
  const maybeError = error as {
    status?: number;
    error?: string;
    message?: string;
  };
  const text = `${maybeError.error ?? ""} ${
    maybeError.message ?? ""
  }`.toLowerCase();
  return (
    maybeError.status === 401 ||
    maybeError.status === 403 ||
    text.includes("scope")
  );
}

export const server = {
  rsvpEvent: defineAction({
    accept: "form",
    input: z.object({
      eventUri: z.string(),
      eventCid: z.string(),
      status: z.enum(["going", "notgoing"]),
    }),
    handler: async (input, ctx) => {
      const loggedInUser = ctx.locals.loggedInUser;

      if (!loggedInUser) {
        return { redirectUrl: redirectWithStatus("error") };
      }

      if (!isValidEventUri(input.eventUri) || input.eventCid.length === 0) {
        return { redirectUrl: redirectWithStatus("error") };
      }

      try {
        await setRsvpStatus(
          loggedInUser,
          { uri: input.eventUri, cid: input.eventCid },
          FORM_STATUS_TO_RSVP_STATUS[input.status],
        );
      } catch (error) {
        return {
          redirectUrl: redirectWithStatus(
            isPermissionError(error) ? "permission" : "error",
          ),
        };
      }

      return {
        redirectUrl: redirectWithStatus(input.status),
      };
    },
  }),
};
