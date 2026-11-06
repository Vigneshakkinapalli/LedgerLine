import type pg from 'pg';

export async function audit(client: pg.PoolClient, actorUserId: string | null, eventType: string, entityType: string, entityId: string | null, metadata: Record<string, unknown>, correlationId?: string): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (actor_user_id, event_type, entity_type, entity_id, metadata, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorUserId, eventType, entityType, entityId, JSON.stringify(metadata), correlationId ?? null]
  );
}
