-- Message families: record the FORMATTED message, not just its plain half.
--
-- Until 2026-09-21 this surface sent plain text only, so `body_text` was the
-- whole email and the record was complete. Now an operator's message is written
-- in the shared body editor and sent as HTML with a derived plain-text half, so
-- storing only `body_text` would make the message history answer "what did I
-- send?" with the bold and the links quietly removed.
--
-- Additive and nullable on purpose:
--   * every existing row stays valid and unchanged - the 64 sends already on
--     prod were genuinely plain text, and NULL is the truthful value for them,
--     not an empty string pretending there was formatting;
--   * the edge function writes NULL for any caller that still sends only text,
--     so this column can land before, after or without the function deploy
--     without a window where either half is broken.
alter table public.program_family_messages
  add column if not exists body_html text;

comment on column public.program_family_messages.body_html is
  'The message as sent, in HTML. NULL for sends made before 2026-09-21 and for any text-only send; body_text is always populated and is the plain-text half that was actually delivered.';
