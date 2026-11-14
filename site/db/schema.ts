import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const studyState = sqliteTable('study_state', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const surveySessions = sqliteTable('survey_sessions', {
  code: text('code').primaryKey(),
  title: text('title').notNull(),
  samples: text('samples').notNull(),
  questionnaire: text('questionnaire').notNull(),
  controlHash: text('control_hash').notNull(),
  phase: text('phase').notNull(),
  currentIndex: integer('current_index').notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const surveyParticipants = sqliteTable('survey_participants', {
  id: text('id').primaryKey(),
  sessionCode: text('session_code').notNull().references(() => surveySessions.code),
  tokenHash: text('token_hash').notNull(),
  joinedAt: text('joined_at').notNull(),
}, table => [uniqueIndex('survey_participant_token').on(table.sessionCode, table.tokenHash)]);

export const surveyResponses = sqliteTable('survey_responses', {
  id: text('id').primaryKey(),
  sessionCode: text('session_code').notNull().references(() => surveySessions.code),
  participantId: text('participant_id').notNull().references(() => surveyParticipants.id),
  sampleId: text('sample_id').notNull(),
  trialIndex: integer('trial_index').notNull(),
  answers: text('answers').notNull(),
  choiceOrder: text('choice_order').notNull(),
  rating: text('rating').notNull(),
  recordedAt: text('recorded_at').notNull(),
  deletedAt: text('deleted_at'),
}, table => [uniqueIndex('survey_response_participant_sample').on(table.participantId, table.sampleId)]);
