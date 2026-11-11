-- 0030: 0028 granted `anon` EXECUTE on is_within_service_hours so a visitor's menu could show "open now". The menu is
-- no longer public (0029), and nothing without a session needs the municipal window, so the grant goes back.
-- Signed-in roles and service_role keep their existing EXECUTE. REVOKE only: no data is touched.
revoke execute on function public.is_within_service_hours(text, public.order_kind, timestamptz) from anon;
