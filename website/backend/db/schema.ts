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

export const prefilterListeningStudies = sqliteTable('prefilter_listening_studies', {
  id: text('id').primaryKey(), fingerprint: text('fingerprint').notNull(), snapshot: text('snapshot').notNull(), createdAt: text('created_at').notNull(),
});
export const prefilterListeningParticipants = sqliteTable('prefilter_listening_participants', {
  id: text('id').primaryKey(), studyId: text('study_id').notNull().references(() => prefilterListeningStudies.id),
  groupId: text('group_id').notNull(), tokenHash: text('token_hash').notNull(), orderJson: text('order_json').notNull(), joinedAt: text('joined_at').notNull(),
}, table => [uniqueIndex('prefilter_listening_participant_token').on(table.studyId, table.tokenHash)]);
export const prefilterListeningPlays = sqliteTable('prefilter_listening_plays', {
  id: text('id').primaryKey(), participantId: text('participant_id').notNull().references(() => prefilterListeningParticipants.id),
  trialIndex: integer('trial_index').notNull(), recordedAt: text('recorded_at').notNull(),
});
export const prefilterListeningResponses = sqliteTable('prefilter_listening_responses', {
  id: text('id').primaryKey(), participantId: text('participant_id').notNull().references(() => prefilterListeningParticipants.id),
  trialIndex: integer('trial_index').notNull(), pairIndex: integer('pair_index').notNull(), mode: text('mode').notNull(), payload: text('payload').notNull(),
  choiceOrder: text('choice_order').notNull(), noise: integer('noise').notNull(), naturalness: integer('naturalness').notNull(), keyCorrect: integer('key_correct').notNull(), recordedAt: text('recorded_at').notNull(),
}, table => [uniqueIndex('prefilter_listening_participant_trial').on(table.participantId, table.trialIndex)]);
