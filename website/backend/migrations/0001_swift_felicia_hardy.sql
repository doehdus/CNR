CREATE TABLE `survey_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`session_code` text NOT NULL,
	`token_hash` text NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`session_code`) REFERENCES `survey_sessions`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `survey_participant_token` ON `survey_participants` (`session_code`,`token_hash`);--> statement-breakpoint
CREATE TABLE `survey_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`session_code` text NOT NULL,
	`participant_id` text NOT NULL,
	`sample_id` text NOT NULL,
	`trial_index` integer NOT NULL,
	`answers` text NOT NULL,
	`choice_order` text NOT NULL,
	`rating` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`session_code`) REFERENCES `survey_sessions`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `survey_participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `survey_response_participant_sample` ON `survey_responses` (`participant_id`,`sample_id`);--> statement-breakpoint
CREATE TABLE `survey_sessions` (
	`code` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`samples` text NOT NULL,
	`questionnaire` text NOT NULL,
	`control_hash` text NOT NULL,
	`phase` text NOT NULL,
	`current_index` integer NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
