import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  activityPlanSchema,
  clubPlanningProfileSchema,
  planDraftSchema,
  planCommandSchema,
  type ActivityPlan,
  type ActivityRecord,
  type ClubPlanningProfile,
  type PlanDraft,
  type PlanCommand,
} from '../shared/contracts/generated.js';
import type { Office } from './office.js';
import { appendAudit, type LocalIdentity } from './permissions.js';
import {
  gameEndpoint,
  gameResource,
  loadPlan,
  requirePlanPolicy,
  setPolishedPlan,
} from './planning-state.js';
import { privateOfficeAiArtifact } from './office-ai-state.js';
import { privateReportArtifact } from './report-state.js';
import { points } from './points.js';
import { now, requireThat, type Store } from './store.js';
import { bearer, field, record } from './validate.js';

export class Planning {
  constructor(
    private readonly store: Store,
    private readonly identity: LocalIdentity,
    private readonly office: Office,
  ) {}

  profile(actor: string, club: string): ClubPlanningProfile {
    this.identity.authenticate(actor);
    const row = this.store.db
      .prepare('SELECT kind FROM club_planning_profiles WHERE club=?')
      .get(club);
    requireThat(row, 'Club planning profile not found');
    return { club, kind: row.kind as ClubPlanningProfile['kind'] };
  }

  putProfile(actor: string, club: string, profile: ClubPlanningProfile) {
    return this.identity.authorized(actor, `club:${club}`, 'manage', () => {
      requireThat(club === profile.club, 'Profile club must match');
      this.store.db
        .prepare(
          'INSERT INTO club_planning_profiles VALUES(?,?) ON CONFLICT(club) DO UPDATE SET kind=excluded.kind',
        )
        .run(club, profile.kind);
      appendAudit(this.store, actor, `club:${club}`, 'planning_profile', club, profile);
      return profile;
    });
  }

  private save(plan: ActivityPlan) {
    this.store.db
      .prepare(
        'INSERT INTO event_plans VALUES(?,?) ON CONFLICT(event) DO UPDATE SET state=excluded.state',
      )
      .run(plan.event, JSON.stringify(plan));
  }

  private editable(event: ActivityRecord, plan?: ActivityPlan) {
    requireThat(event.phase === 'draft' && !plan?.finalized, 'Unfinalized draft plan required');
  }

  put(actor: string, eventId: string, input: PlanDraft) {
    return this.identity.authorized(actor, `event:${eventId}`, 'manage', () => {
      const event = this.office.load(eventId);
      this.editable(event, loadPlan(this.store, eventId));
      requireThat(event.epoch === input.epoch, 'Current event epoch required');
      const clubs = new Set(input.clubs.map((club) => club.club));
      requireThat(
        clubs.size === input.clubs.length &&
          clubs.size === event.coOrganizers.length + 1 &&
          [event.club, ...event.coOrganizers].every((club) => clubs.has(club)),
        'Plan clubs must match event organizers',
      );
      const participants = new Set<string>();
      for (const club of input.clubs) {
        requireThat(
          this.profile(actor, club.club).kind === club.kind,
          'Current club kind required',
        );
        requireThat(
          input.kind !== 'meeting' || club.participants.length,
          'Meeting participants required',
        );
        for (const member of club.participants) {
          this.identity.requireMembership(member, club.club);
          requireThat(!participants.has(member), 'Participant must belong to one plan club');
          participants.add(member);
        }
      }
      requireThat(
        input.kind !== 'online' || input.candidates.length,
        'Online game candidates required',
      );
      requireThat(
        input.kind !== 'meeting' || !input.candidates.length,
        'Meeting plan has no game resources',
      );
      for (const candidate of input.candidates)
        requireThat(
          clubs.has(gameResource(this.store, candidate).club),
          'Participating resource owner required',
        );
      const plan: ActivityPlan = {
        ...input,
        id: randomUUID(),
        event: eventId,
        selected: [],
        opinions: [],
        consents: [],
        rewards: [],
        finalized: false,
        evidence: null,
        polished: null,
      };
      this.save(plan);
      appendAudit(this.store, actor, `event:${eventId}`, 'plan', plan.id, input);
      return plan;
    });
  }

  read(actor: string, event: string) {
    return this.store.transaction(() => {
      this.identity.authenticate(actor);
      const plan = loadPlan(this.store, event);
      requireThat(plan, 'Event plan not found');
      requireThat(
        this.identity.decide(actor, `event:${event}`, 'manage') ||
          plan.clubs.some(
            (club) =>
              this.identity.decide(actor, `club:${club.club}`, 'manage') ||
              (club.participants.includes(actor) && this.identity.isActiveMember(actor, club.club)),
          ),
        'Planning participant required',
      );
      return plan;
    });
  }

  private document(
    actor: string,
    plan: ActivityPlan,
    club: string,
    id: string,
    audience: 'club' | 'personal',
  ) {
    const artifact = this.office.artifactContent(actor, id);
    requireThat(
      artifact.metadata.visibility === 'private' &&
        artifact.metadata.owner === actor &&
        artifact.metadata.club === club,
      'Own private planning document required',
    );
    requireThat(
      !this.store.db.prepare('SELECT 1 FROM event_artifacts WHERE artifact=?').get(id) &&
        !this.store.db
          .prepare("SELECT 1 FROM workflows WHERE json_extract(state,'$.brief')=?")
          .get(id) &&
        !this.store.db
          .prepare("SELECT 1 FROM planning_documents WHERE artifact=? AND audience='event'")
          .get(id),
      'Planning document must remain private',
    );
    this.store.db
      .prepare('INSERT OR IGNORE INTO planning_documents VALUES(?,?,?,?,?)')
      .run(id, plan.event, plan.id, club, audience);
  }

  private reserve(event: ActivityRecord, plan: ActivityPlan) {
    const endpoints = new Set<string>();
    for (const selected of plan.selected) {
      const resource = gameResource(this.store, selected);
      const endpoint = gameEndpoint(resource.address);
      requireThat(!endpoints.has(endpoint), 'Selected games must use distinct endpoints');
      endpoints.add(endpoint);
      requireThat(
        !this.store.db
          .prepare('SELECT 1 FROM event_reservations WHERE endpoint=? AND opens_ms<? AND ends_ms>?')
          .get(endpoint, event.endsMs, event.checkinOpensMs),
        'Game endpoint already reserved',
      );
      requireThat(
        this.store.db
          .prepare("SELECT resource FROM leagues WHERE json_extract(state,'$.phase')='playing'")
          .all()
          .every(
            (league) =>
              gameEndpoint(gameResource(this.store, String(league.resource)).address) !== endpoint,
          ),
        'Game endpoint is playing',
      );
      this.store.db
        .prepare('INSERT INTO event_reservations VALUES(?,?,?,?,?)')
        .run(event.id, selected, endpoint, event.checkinOpensMs, event.endsMs);
    }
  }

  private evidence(actor: string, event: ActivityRecord, plan: ActivityPlan) {
    const documents = new Set([
      event.brief,
      ...plan.opinions.map((opinion) => opinion.document),
      ...plan.consents.flatMap((consent) =>
        consent.transcript ? [consent.document, consent.transcript] : [consent.document],
      ),
    ]);
    const materials = [...documents].map((id) => {
      const row = this.store.db
        .prepare('SELECT mime,content FROM office_artifacts WHERE id=?')
        .get(id);
      requireThat(row, 'Planning artifact required');
      return {
        id,
        mime: String(row.mime),
        content: Buffer.from(row.content as Uint8Array).toString('base64'),
      };
    });
    const id = this.office.storeSnapshot(actor, event.club, event.title, {
      event,
      plan,
      materials,
    });
    this.store.db
      .prepare("INSERT INTO planning_documents VALUES(?,?,?,?,'event')")
      .run(id, event.id, plan.id, event.club);
    return id;
  }

  execute(actor: string, eventId: string, command: PlanCommand) {
    return this.identity.action(actor, `event:${eventId}`, `plan_${command.action}`, () => {
      this.identity.authenticate(actor);
      const event = this.office.load(eventId);
      const plan = loadPlan(this.store, eventId);
      requireThat(plan?.id === command.plan && plan.epoch === event.epoch, 'Current plan required');
      if (command.action === 'finalize' || command.action === 'polish') {
        requireThat(
          this.identity.decide(actor, `event:${eventId}`, 'manage'),
          'Event planning authority required',
        );
      } else {
        this.editable(event, plan);
        const club = plan.clubs.find((entry) => entry.club === command.club);
        requireThat(club, 'Participating club required');
        const personal = command.action === 'consent' && club.kind === 'independent';
        requireThat(
          personal
            ? club.participants.includes(actor)
            : this.identity.decide(actor, `club:${club.club}`, 'manage'),
          'Club planning authority required',
        );
        this.identity.requireMembership(actor, club.club);
      }
      return () => {
        switch (command.action) {
          case 'opinion':
            requireThat(
              command.games.every((game) => plan.candidates.includes(game)),
              'Candidate games required',
            );
            this.document(actor, plan, command.club, command.document, 'club');
            plan.opinions = plan.opinions.filter((opinion) => opinion.club !== command.club);
            plan.opinions.push({
              club: command.club,
              actor,
              document: command.document,
              games: command.games,
            });
            break;
          case 'consent': {
            const club = plan.clubs.find((entry) => entry.club === command.club)!;
            const audience = club.kind === 'independent' ? 'personal' : 'club';
            this.document(actor, plan, command.club, command.document, audience);
            if (command.transcript)
              this.document(actor, plan, command.club, command.transcript, audience);
            plan.consents = plan.consents.filter(
              (consent) =>
                consent.club !== club.club ||
                (club.kind === 'independent' && consent.actor !== actor),
            );
            plan.consents.push({
              club: club.club,
              actor,
              document: command.document,
              transcript: command.transcript,
            });
            break;
          }
          case 'rewards':
            points(command.rule.points);
            requireThat(
              command.rule.material === null || command.rule.material.trim(),
              'Material reward text required',
            );
            plan.rewards = plan.rewards.filter((reward) => reward.club !== command.club);
            plan.rewards.push({ club: command.club, actor, rule: command.rule });
            break;
          case 'finalize':
            this.editable(event, plan);
            requireThat(
              command.selected.every((game) => plan.candidates.includes(game)) &&
                (plan.kind !== 'online' || command.selected.length),
              'Selected candidate games required',
            );
            requireThat(Date.now() < event.window.closesMs, 'Future event registration required');
            plan.selected = command.selected;
            requirePlanPolicy(this.store, this.identity, event, plan);
            this.reserve(event, plan);
            plan.finalized = true;
            plan.evidence = this.evidence(actor, event, plan);
            break;
          case 'polish': {
            requireThat(
              event.phase === 'draft' && plan.finalized && !plan.polished,
              'Finalized draft plan required',
            );
            const artifact = this.office.artifactContent(actor, command.document);
            requireThat(
              ['text/plain', 'text/markdown'].includes(artifact.metadata.mime) &&
                !privateOfficeAiArtifact(this.store, command.document) &&
                !privateReportArtifact(this.store, command.document) &&
                !this.store.db
                  .prepare('SELECT 1 FROM planning_documents WHERE artifact=?')
                  .get(command.document),
              'Publishable polished document required',
            );
            setPolishedPlan(this.store, event, plan, command.document);
            break;
          }
        }
        this.save(plan);
        appendAudit(
          this.store,
          actor,
          `event:${eventId}`,
          `plan_${command.action}`,
          plan.id,
          command,
        );
        return plan;
      };
    });
  }
}

export function registerPlanning(
  app: FastifyInstance,
  store: Store,
  identity: LocalIdentity,
  office: Office,
) {
  const planning = new Planning(store, identity, office);
  const actor = (request: FastifyRequest) =>
    store.token(bearer(request.headers.authorization), undefined, now()).id;
  const id = (request: FastifyRequest) => field(record(request.params).id, 128);
  app.get(
    '/api/clubs/:id/planning-profile',
    {
      schema: { response: { 200: clubPlanningProfileSchema } },
    },
    async (request) => planning.profile(actor(request), id(request)),
  );
  app.put<{ Body: ClubPlanningProfile }>(
    '/api/clubs/:id/planning-profile',
    {
      schema: { body: clubPlanningProfileSchema, response: { 200: clubPlanningProfileSchema } },
    },
    async (request) => planning.putProfile(actor(request), id(request), request.body),
  );
  app.get(
    '/api/events/:id/plan',
    {
      schema: { response: { 200: activityPlanSchema } },
    },
    async (request) => planning.read(actor(request), id(request)),
  );
  app.put<{ Body: PlanDraft }>(
    '/api/events/:id/plan',
    {
      schema: { body: planDraftSchema, response: { 200: activityPlanSchema } },
    },
    async (request) => planning.put(actor(request), id(request), request.body),
  );
  app.post<{ Body: PlanCommand }>(
    '/api/events/:id/plan/actions',
    {
      schema: { body: planCommandSchema, response: { 200: activityPlanSchema } },
    },
    async (request) => planning.execute(actor(request), id(request), request.body),
  );
  return planning;
}
