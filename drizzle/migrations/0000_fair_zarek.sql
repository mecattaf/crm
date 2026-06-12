CREATE TABLE `activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject` text NOT NULL,
	`subject_norm` text NOT NULL,
	`activity_type` text NOT NULL,
	`due_date` text NOT NULL,
	`due_time` text,
	`duration_min` integer,
	`priority` text DEFAULT 'none' NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`done_at` text,
	`note` text,
	`assignee_id` integer,
	`deal_id` integer,
	`org_id` integer,
	`contact_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activities_due_date_idx` ON `activities` (`due_date`);--> statement-breakpoint
CREATE INDEX `activities_deal_idx` ON `activities` (`deal_id`);--> statement-breakpoint
CREATE INDEX `activities_org_idx` ON `activities` (`org_id`);--> statement-breakpoint
CREATE INDEX `activities_contact_idx` ON `activities` (`contact_id`);--> statement-breakpoint
CREATE INDEX `activities_assignee_idx` ON `activities` (`assignee_id`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`first_name_norm` text NOT NULL,
	`last_name_norm` text NOT NULL,
	`org_id` integer,
	`email` text,
	`phone` text,
	`job_title` text,
	`owner_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contacts_last_name_norm_idx` ON `contacts` (`last_name_norm`);--> statement-breakpoint
CREATE INDEX `contacts_org_idx` ON `contacts` (`org_id`);--> statement-breakpoint
CREATE TABLE `deals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`title_norm` text NOT NULL,
	`org_id` integer,
	`contact_id` integer,
	`pipeline_id` integer NOT NULL,
	`stage_id` integer NOT NULL,
	`value_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'EUR' NOT NULL,
	`expected_close_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`lost_reason` text,
	`label` text,
	`owner_id` integer,
	`stage_changed_at` text NOT NULL,
	`won_at` text,
	`lost_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stage_id`) REFERENCES `stages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deals_title_norm_idx` ON `deals` (`title_norm`);--> statement-breakpoint
CREATE INDEX `deals_stage_idx` ON `deals` (`stage_id`);--> statement-breakpoint
CREATE INDEX `deals_pipeline_idx` ON `deals` (`pipeline_id`);--> statement-breakpoint
CREATE INDEX `deals_org_idx` ON `deals` (`org_id`);--> statement-breakpoint
CREATE INDEX `deals_status_idx` ON `deals` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`actor_user_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_entity_idx` ON `events` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`currency` text PRIMARY KEY NOT NULL,
	`rate_to_eur_micros` integer NOT NULL,
	`as_of` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`body` text NOT NULL,
	`body_norm` text NOT NULL,
	`author_id` integer,
	`deal_id` integer,
	`org_id` integer,
	`contact_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notes_deal_idx` ON `notes` (`deal_id`);--> statement-breakpoint
CREATE INDEX `notes_org_idx` ON `notes` (`org_id`);--> statement-breakpoint
CREATE INDEX `notes_contact_idx` ON `notes` (`contact_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`client_code` text,
	`category` text,
	`org_type` text,
	`address` text,
	`delivery_address` text,
	`accise_1` text,
	`accise_2` text,
	`owner_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `organizations_name_norm_idx` ON `organizations` (`name_norm`);--> statement-breakpoint
CREATE TABLE `pipelines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pipeline_id` integer NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`position` integer NOT NULL,
	`rot_days` integer,
	`forecast_weight` integer DEFAULT 50 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stages_pipeline_idx` ON `stages` (`pipeline_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);