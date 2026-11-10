-- fx_rates is versioned by date and orders freeze the exact row they used, so a day must not be
-- ambiguous. At most one API row and at most one manual-override row per pair and date: the manual
-- row (when present) wins at read time, and a duplicate cron run is a no-op (on conflict do nothing).
-- is_manual_override is part of the key on purpose: a key of (pair, valid_for_date) alone would make
-- an admin override impossible on any day the API already filled.
alter table public.fx_rates
  add constraint fx_rates_pair_date_kind_key unique (pair, valid_for_date, is_manual_override);
