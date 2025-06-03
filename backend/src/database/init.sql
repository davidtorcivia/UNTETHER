-- Screen Time Game Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create event_type enum
CREATE TYPE event_type AS ENUM ('LOCKED', 'UNLOCKED');

-- Create group_type enum  
CREATE TYPE group_type AS ENUM ('PUBLIC', 'PRIVATE');

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on username and email for faster lookups
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);

-- Screen events table
CREATE TABLE screen_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_uuid VARCHAR(255) NOT NULL,
    event_type event_type NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for screen events
CREATE INDEX idx_screen_events_user_id ON screen_events(user_id);
CREATE INDEX idx_screen_events_timestamp ON screen_events(timestamp);
CREATE INDEX idx_screen_events_processed ON screen_events(processed);
CREATE INDEX idx_screen_events_device_uuid ON screen_events(device_uuid);

-- Weekly scores table
CREATE TABLE weekly_scores (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    total_score INTEGER DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, week_start)
);

-- Create indexes for weekly scores
CREATE INDEX idx_weekly_scores_user_id ON weekly_scores(user_id);
CREATE INDEX idx_weekly_scores_week_start ON weekly_scores(week_start);

-- Groups table
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(50) NOT NULL,
    description VARCHAR(200),
    type group_type NOT NULL,
    invite_code VARCHAR(10) UNIQUE,
    creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for groups
CREATE INDEX idx_groups_creator_id ON groups(creator_id);
CREATE INDEX idx_groups_invite_code ON groups(invite_code);
CREATE INDEX idx_groups_type ON groups(type);
CREATE INDEX idx_groups_name ON groups(name) WHERE type = 'PUBLIC';

-- Group members table
CREATE TABLE group_members (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);

-- Create indexes for group members
CREATE INDEX idx_group_members_user_id ON group_members(user_id);
CREATE INDEX idx_group_members_group_id ON group_members(group_id);

-- Refresh tokens table (for JWT)
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    device_info JSONB,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for refresh tokens
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- Device certificates table (for anti-tampering)
CREATE TABLE device_certificates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_uuid VARCHAR(255) NOT NULL,
    certificate_hash VARCHAR(255) NOT NULL,
    device_info JSONB,
    last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, device_uuid)
);

-- Create indexes for device certificates
CREATE INDEX idx_device_certificates_user_id ON device_certificates(user_id);
CREATE INDEX idx_device_certificates_device_uuid ON device_certificates(device_uuid);

-- Function to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for users table
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to generate random invite codes
CREATE OR REPLACE FUNCTION generate_invite_code()
RETURNS TEXT AS $$
DECLARE
    chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    result TEXT := '';
    i INTEGER := 0;
BEGIN
    FOR i IN 1..8 LOOP
        result := result || substr(chars, trunc(random() * length(chars))::int + 1, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate invite codes for groups
CREATE OR REPLACE FUNCTION set_invite_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invite_code IS NULL THEN
        LOOP
            NEW.invite_code := generate_invite_code();
            -- Check if this code already exists
            IF NOT EXISTS (SELECT 1 FROM groups WHERE invite_code = NEW.invite_code) THEN
                EXIT;
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_group_invite_code BEFORE INSERT ON groups
FOR EACH ROW EXECUTE FUNCTION set_invite_code();

-- Function to clean up expired refresh tokens
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void AS $$
BEGIN
    DELETE FROM refresh_tokens WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Views for commonly used queries

-- User profile with stats
CREATE VIEW user_profiles AS
SELECT 
    u.id,
    u.username,
    u.email,
    u.timezone,
    u.created_at,
    COALESCE(ws.total_score, 0) as current_week_score,
    (SELECT COUNT(*) FROM group_members gm WHERE gm.user_id = u.id) as group_count
FROM users u
LEFT JOIN weekly_scores ws ON u.id = ws.user_id 
    AND ws.week_start = date_trunc('week', NOW() AT TIME ZONE u.timezone)::date;

-- Group leaderboards
CREATE VIEW group_leaderboards AS
SELECT 
    g.id as group_id,
    g.name as group_name,
    u.id as user_id,
    u.username,
    COALESCE(ws.total_score, 0) as score,
    ws.last_updated,
    ROW_NUMBER() OVER (PARTITION BY g.id ORDER BY COALESCE(ws.total_score, 0) DESC) as rank
FROM groups g
JOIN group_members gm ON g.id = gm.group_id
JOIN users u ON gm.user_id = u.id
LEFT JOIN weekly_scores ws ON u.id = ws.user_id 
    AND ws.week_start = date_trunc('week', NOW() AT TIME ZONE u.timezone)::date;
