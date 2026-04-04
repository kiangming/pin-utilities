-- Ticket Reminder Feature — Supabase Migration
-- Chạy thủ công trên Supabase SQL Editor

CREATE TABLE remind_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE webhook_configs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name TEXT NOT NULL UNIQUE,
  product_code TEXT,
  channel_name TEXT NOT NULL,
  webhook_url  TEXT NOT NULL,
  template_id  UUID REFERENCES remind_templates(id) ON DELETE SET NULL,
  is_default   BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE handler_usernames (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username   TEXT NOT NULL UNIQUE,
  full_name  TEXT,
  note       TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE remind_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   TEXT NOT NULL,
  ticket_url  TEXT,
  product     TEXT,
  requester   TEXT,
  due_date    DATE,
  webhook_id  UUID REFERENCES webhook_configs(id) ON DELETE SET NULL,
  template_id UUID REFERENCES remind_templates(id) ON DELETE SET NULL,
  message     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error_msg   TEXT,
  reminded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE products (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  code      TEXT,
  alias     TEXT,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE services (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  synced_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ticket_statuses (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT false,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: 2 default templates
INSERT INTO remind_templates (name, content, is_default) VALUES
  ('Sandbox Expiry EN', 'Hi {requester_name}, the sandbox account for {product_name} (ticket #{ticket_id}) {time_label}. Do you need to extend it? If so, please leave a comment on the ticket. Thank you!', true),
  ('Sandbox Expiry VI', 'Xin chào {requester_name}, tài khoản sandbox cho {product_name} (ticket #{ticket_id}) {time_label}. Bạn có cần gia hạn tiếp không? Nếu có vui lòng comment vào ticket nhé. Cảm ơn!', false);
