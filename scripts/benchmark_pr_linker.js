#!/usr/bin/env node
import { suggest_pr_jira_links_from_data } from '../server/index.js';

const fixtures = [
  {
    pr: {
      title: 'Fix null pointer in Jira import flow',
      description: 'The Jira import microservice fails when the issue payload omits assignee metadata. This PR updates validation and adds a regression test.'
    },
    correct_ticket_key: 'JIRA-101'
  },
  {
    pr: {
      title: 'Add team capacity chart to sprint dashboard',
      description: 'This change adds a new chart to the sprint dashboard showing team capacity utilization over the current sprint.'
    },
    correct_ticket_key: 'JIRA-102'
  },
  {
    pr: {
      title: 'Optimize search indexing for work category contents',
      description: 'Reduce search latency by caching the work category contents response and invalidating on updates.'
    },
    correct_ticket_key: 'JIRA-103'
  },
  {
    pr: {
      title: 'Support bulk update on linked tickets',
      description: 'Adds bulk editing support for Jira-linked tickets so users can update status and labels for multiple work items.'
    },
    correct_ticket_key: 'JIRA-104'
  },
  {
    pr: {
      title: 'Add retry logic to API export requests',
      description: 'Improve stability of API export by retrying transient failures when fetching data from external services.'
    },
    correct_ticket_key: 'JIRA-105'
  },
  {
    pr: {
      title: 'Fix display bug in work item summary panel',
      description: 'The work item summary panel truncated long titles incorrectly. This PR fixes layout constraints and adds an end-to-end test.'
    },
    correct_ticket_key: 'JIRA-106'
  },
  {
    pr: {
      title: 'Update Jira ticket sync to support new issue schema',
      description: 'The sync job must handle the new issue payload schema introduced by the Jira integration update.'
    },
    correct_ticket_key: 'JIRA-107'
  },
  {
    pr: {
      title: 'Deprecate old work category payload fields',
      description: 'Remove legacy payload fields from the work category API responses and update consumers to use the new schema.'
    },
    correct_ticket_key: 'JIRA-108'
  },
  {
    pr: {
      title: 'Improve error handling for unlinked pull requests',
      description: 'Add clearer error messages and retry behavior when the unlinked pull requests service returns malformed data.'
    },
    correct_ticket_key: 'JIRA-109'
  },
  {
    pr: {
      title: 'Add analytics event for ticket match suggestions',
      description: 'Track when suggested Jira matches are accepted, rejected, or ignored by users in the PR review workflow.'
    },
    correct_ticket_key: 'JIRA-110'
  }
];

const ticketCandidates = [
  { key: 'JIRA-101', title: 'Fix Jira import null pointer exception', description: 'Validation fails when assignee metadata is missing during Jira import. Add null checks and regression tests.' },
  { key: 'JIRA-102', title: 'Sprint dashboard team capacity chart', description: 'Display team capacity utilization for the current sprint on the dashboard, including available and committed effort.' },
  { key: 'JIRA-103', title: 'Cache work category contents search results', description: 'Cache the results of work category contents queries and invalidate on updates to reduce latency.' },
  { key: 'JIRA-104', title: 'Bulk update for linked tickets', description: 'Allow bulk editing of Jira-linked tickets, including status and label updates across selected items.' },
  { key: 'JIRA-105', title: 'Retry external API export requests', description: 'Add retry behavior for transient failures when calling API export endpoints from the sync service.' },
  { key: 'JIRA-106', title: 'Fix work item summary panel truncation', description: 'Resolve the layout bug where long work item titles were truncated incorrectly in the summary panel.' },
  { key: 'JIRA-107', title: 'Support new Jira issue schema in sync job', description: 'Update Jira ticket sync to handle the new issue payload schema from the Jira integration update.' },
  { key: 'JIRA-108', title: 'Deprecate legacy work category payload fields', description: 'Remove old payload fields from work category API responses and update consumers to the new schema.' },
  { key: 'JIRA-109', title: 'Improve unlinked pull request error handling', description: 'Enhance error messages and retry behavior for malformed unlinked pull request responses.' },
  { key: 'JIRA-110', title: 'Track analytics for suggestion acceptance', description: 'Emit analytics events when users accept, reject, or ignore suggested Jira ticket matches.' }
];

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text.slice(0, width - 1) : text.padEnd(width, ' ');
}

async function runBenchmark() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY environment variable.');
    process.exit(1);
  }

  const prObjects = fixtures.map(fixture => fixture.pr);
  const result = await suggest_pr_jira_links_from_data(prObjects, ticketCandidates, {
    min_confidence: 0.0,
    max_suggestions_per_pr: 3
  });

  if (result.error) {
    console.error('Benchmark failed:', result.error);
    if (result.message) {
      console.error(result.message);
    }
    process.exit(1);
  }

  const rows = [];
  let top1Count = 0;
  let top3Count = 0;
  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const [index, suggestion] of result.suggestions.entries()) {
    const correctKey = fixtures[index].correct_ticket_key;
    const topSuggestion = suggestion.suggestions[0]?.key || 'NONE';
    const inTop3 = suggestion.suggestions.slice(0, 3).some(item => item.key === correctKey);
    const correctMatch = suggestion.suggestions.find(item => item.key === correctKey);
    const confidence = correctMatch ? correctMatch.confidence : 0;

    if (topSuggestion === correctKey) top1Count += 1;
    if (inTop3) top3Count += 1;
    if (correctMatch) {
      totalConfidence += confidence;
      confidenceCount += 1;
    }

    rows.push({
      title: fixtures[index].pr.title,
      correct: correctKey,
      top: topSuggestion,
      inTop3: inTop3 ? 'yes' : 'no',
      confidence: confidence.toFixed(2)
    });
  }

  const precisionAt1 = top1Count / fixtures.length;
  const precisionAt3 = top3Count / fixtures.length;
  const meanConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;

  console.log(pad('PR title', 40), pad('correct ticket', 15), pad('top suggestion', 15), pad('correct in top 3', 16), 'confidence');
  console.log('-'.repeat(95));
  for (const row of rows) {
    console.log(pad(row.title, 40), pad(row.correct, 15), pad(row.top, 15), pad(row.inTop3, 16), row.confidence);
  }

  console.log('\nSummary:');
  console.log(`precision@1: ${precisionAt1.toFixed(2)}`);
  console.log(`precision@3: ${precisionAt3.toFixed(2)}`);
  console.log(`mean confidence: ${meanConfidence.toFixed(2)}`);
}

runBenchmark().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
