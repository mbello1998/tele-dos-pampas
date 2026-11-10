-- pricing_rules is dated history, exactly like fx_rates (0016): "versioned by date, never edited in place;
-- a price change creates a new version" (spec 6.5). An order freezes BOTH pricing_breakdown and
-- pricing_rule_id; if the referenced rule row could be rewritten later, the frozen breakdown and the rule
-- it cites would stop agreeing and the audit trail would look authoritative while lying about why an
-- order cost what it cost.
--
-- Rules, for EVERY role (admin included, and also the table owner and service_role):
--   * INSERT   a new version is a new row; the exclusion constraint pricing_rules_no_overlap polices overlaps
--              and the idempotent seed (insert ... where not exists) is unaffected.
--   * UPDATE   allowed only when valid_to is the sole changed column: that is closing a version so the next
--              one can take effect. A valid_to change that rides along with ANY other column is rejected,
--              so nobody can slip a price change in beside a legitimate close.
--   * DELETE   never.
-- This is an unconditional trigger, not a policy: it holds even for roles that bypass RLS. Maintenance that
-- truly needs to rewrite history must disable the trigger explicitly, which leaves a trace in the DDL log.

create function private.pricing_rules_history_guard() returns trigger
language plpgsql set search_path = ''
as $$
declare
  col text;
begin
  if tg_op = 'DELETE' then
    raise exception 'pricing_rules is history: a rule version is closed with valid_to and replaced by a new row, never deleted'
      using errcode = '42501';
  end if;
  for col in
    select n.key from jsonb_each(to_jsonb(new)) n
    where n.value is distinct from (to_jsonb(old) -> n.key)
  loop
    if col <> 'valid_to' then
      raise exception 'pricing_rules.% cannot be edited in place: close the version with valid_to and insert a new one', col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function private.pricing_rules_history_guard() from public;

create trigger pricing_rules_history_guard before update or delete on public.pricing_rules
  for each row execute function private.pricing_rules_history_guard();

-- Same posture as fx_rates: no DELETE policy or privilege for any API role. UPDATE keeps its admin policy
-- (needed to close a version); the trigger decides which column may change.
drop policy if exists pricing_rules_delete_admin on public.pricing_rules;
revoke delete on public.pricing_rules from authenticated;
