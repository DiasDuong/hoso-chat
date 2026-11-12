-- Migration: Add PURGED status to chk_agent_output_status constraint
-- File: sql/migrations/20261020_p1a_add_purged_status.sql
-- Description: Idempotent migration to allow 'PURGED' status on public.agent_output_files
-- Preserves existing statuses: 'GENERATING', 'READY', 'FAILED', 'EXPIRED'

DO $$
BEGIN
    -- 1. Kiểm tra và gỡ bỏ ràng buộc cũ nếu tồn tại
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'chk_agent_output_status' 
          AND conrelid = 'public.agent_output_files'::regclass
    ) THEN
        ALTER TABLE public.agent_output_files 
        DROP CONSTRAINT chk_agent_output_status;
    END IF;

    -- 2. Tái tạo ràng buộc với đầy đủ 5 trạng thái hợp lệ (bổ sung PURGED)
    ALTER TABLE public.agent_output_files 
    ADD CONSTRAINT chk_agent_output_status 
    CHECK (status IN ('GENERATING', 'READY', 'FAILED', 'EXPIRED', 'PURGED'));

    RAISE NOTICE 'Constraint chk_agent_output_status updated successfully to include PURGED.';
END $$;
