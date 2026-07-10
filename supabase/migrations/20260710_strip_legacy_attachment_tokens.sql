-- Strip legacy {{attachment:<uuid>}} tokens from bodies authored while the
-- token-based version of comms attachments was briefly live on staging. The
-- redesign renders Download buttons from email_attachments jsonb, so nothing
-- expands these markers anymore and they'd render as raw text. No-op on prod
-- (prod never had the token feature — the foundation migration was rolled back).

update public.automations
set body_override = nullif(regexp_replace(
      regexp_replace(body_override, '<p>\s*\{\{attachment:[0-9a-fA-F-]{36}\}\}\s*</p>', '', 'gi'),
      '\{\{attachment:[0-9a-fA-F-]{36}\}\}', '', 'gi'), '')
where body_override ~* '\{\{attachment:';

update public.saved_email_templates
set body_html = regexp_replace(
      regexp_replace(body_html, '<p>\s*\{\{attachment:[0-9a-fA-F-]{36}\}\}\s*</p>', '', 'gi'),
      '\{\{attachment:[0-9a-fA-F-]{36}\}\}', '', 'gi'),
    body_text = regexp_replace(coalesce(body_text, ''), '\{\{attachment:[0-9a-fA-F-]{36}\}\}', '', 'gi')
where body_html ~* '\{\{attachment:' or body_text ~* '\{\{attachment:';

update public.marketing_campaign_touchpoints
set payload = jsonb_set(
      jsonb_set(payload, '{body_html}', to_jsonb(regexp_replace(
        regexp_replace(coalesce(payload->>'body_html', ''), '<p>\s*\{\{attachment:[0-9a-fA-F-]{36}\}\}\s*</p>', '', 'gi'),
        '\{\{attachment:[0-9a-fA-F-]{36}\}\}', '', 'gi'))),
      '{body_text}', to_jsonb(regexp_replace(coalesce(payload->>'body_text', ''), '\{\{attachment:[0-9a-fA-F-]{36}\}\}', '', 'gi')))
where payload->>'body_html' ~* '\{\{attachment:' or payload->>'body_text' ~* '\{\{attachment:';
