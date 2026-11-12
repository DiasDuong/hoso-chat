BEGIN;

ALTER TABLE public.user_agents
  ADD COLUMN IF NOT EXISTS agent_type VARCHAR(30) DEFAULT 'GENERAL_ASSISTANT',
  ADD COLUMN IF NOT EXISTS model_name VARCHAR(50) DEFAULT 'gemini-3.1-flash-lite',
  ADD COLUMN IF NOT EXISTS temperature NUMERIC(3,2) DEFAULT 0.70,
  ADD COLUMN IF NOT EXISTS max_steps INT DEFAULT 5,
  ADD COLUMN IF NOT EXISTS enabled_tools JSONB DEFAULT '["web_research"]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_version INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS avatar_icon VARCHAR(50) DEFAULT '🤖';

CREATE INDEX IF NOT EXISTS idx_user_agents_type ON public.user_agents(agent_type);

CREATE TABLE IF NOT EXISTS public.user_agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.user_agents(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  instruction_prompt TEXT NOT NULL,
  model_name VARCHAR(50) NOT NULL,
  temperature NUMERIC(3,2) NOT NULL,
  enabled_tools JSONB DEFAULT '[]'::jsonb,
  change_summary VARCHAR(255) DEFAULT 'Cập nhật cấu hình',
  created_by UUID NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_agent_version UNIQUE(agent_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id ON public.user_agent_versions(agent_id, version_number DESC);

-- Update existing 2 agents
UPDATE public.user_agents
SET 
  avatar_icon = CASE WHEN name ILIKE '%excel%' THEN '📊' ELSE '📧' END,
  agent_type = CASE WHEN name ILIKE '%excel%' THEN 'DATA_ANALYST' ELSE 'GENERAL_ASSISTANT' END,
  model_name = 'gemini-3.1-flash-lite',
  temperature = CASE WHEN name ILIKE '%excel%' THEN 0.20 ELSE 0.70 END;

-- Snapshot version 1
INSERT INTO public.user_agent_versions (agent_id, version_number, name, description, instruction_prompt, model_name, temperature, enabled_tools, change_summary, created_by)
SELECT 
  id, 
  1, 
  name, 
  description, 
  instruction_prompt, 
  model_name, 
  temperature,
  enabled_tools,
  'Phiên bản ban đầu khi nâng cấp lên Gemini 3.1-flash-lite',
  user_id
FROM public.user_agents
ON CONFLICT (agent_id, version_number) DO NOTHING;

COMMIT;
