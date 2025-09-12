-- Comprehensive permission restoration for local Supabase
-- This migration restores all necessary permissions that were revoked in 20250911091801

-- Grant all permissions on games table to service_role
grant all on table "public"."games" to "service_role";

-- Grant all permissions on windows table to service_role
grant all on table "public"."windows" to "service_role";

-- Grant all permissions on snapshots table to service_role
grant all on table "public"."snapshots" to "service_role";

-- Grant SELECT permissions to anon and authenticated for client access
grant select on table "public"."games" to "anon";
grant select on table "public"."games" to "authenticated";

grant select on table "public"."windows" to "anon";
grant select on table "public"."windows" to "authenticated";

grant select on table "public"."snapshots" to "anon";
grant select on table "public"."snapshots" to "authenticated";

-- Grant USAGE on sequences (needed for auto-incrementing IDs)
grant usage on all sequences in schema public to "service_role";
grant usage on all sequences in schema public to "anon";
grant usage on all sequences in schema public to "authenticated";
