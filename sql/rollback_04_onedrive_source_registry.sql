-- ============================================================================
-- SOTRANS HUB — ROLLBACK MIGRATION 04: ONEDRIVE SOURCE REGISTRY
-- ============================================================================

DROP TABLE IF EXISTS public.onedrive_sync_jobs CASCADE;
DROP TABLE IF EXISTS public.onedrive_source_snapshots CASCADE;
DROP TABLE IF EXISTS public.onedrive_graph_subscriptions CASCADE;
DROP TABLE IF EXISTS public.user_onedrive_sources CASCADE;
