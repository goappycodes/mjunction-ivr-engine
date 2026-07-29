/**
 * Idempotent coverage top-up (safe to run repeatedly):
 *   npx tsx supabase/seed/finish.ts
 *
 * For every campaign it dispatches any confirmed-address recipients, delivers
 * most of them, and runs a delivery-confirmation pass (leaving a slice pending)
 * — so Dispatch, VOC vault and the queues are populated for ALL campaigns.
 * Per-recipient try/catch means concurrent app usage can't abort the whole run.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { fakerEN_IN as faker } from '@faker-js/faker';

import type { Campaign, Database, Recipient } from '../../src/lib/database.types';
import { MockTelephonyProvider } from '../../src/lib/telephony/mock-provider';
import { recordDeliveryConfirmationCall } from '../../src/lib/domain/call-flow';
import { transitionStatus, logEvent } from '../../src/lib/domain/audit';

loadEnv({ path: '.env.local' });
faker.seed(4242);

const db = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const provider = new MockTelephonyProvider(db);
const couriers = ['Delhivery', 'Blue Dart', 'DTDC', 'Ekart', 'XpressBees'];

async function refresh(id: string): Promise<Recipient | null> {
  const { data } = await db.from('recipients').select('*').eq('id', id).single();
  return (data as Recipient) ?? null;
}

async function dispatchAndDeliver(adminId: string, campaignId: string) {
  const { data: rows } = await db
    .from('recipients')
    .select('*')
    .eq('campaign_id', campaignId)
    .in('status', ['address_confirmed', 'address_corrected']);

  for (const r0 of (rows ?? []) as Recipient[]) {
    try {
      const r = await refresh(r0.id);
      if (!r || (r.status !== 'address_confirmed' && r.status !== 'address_corrected')) continue;

      const { data: existing } = await db
        .from('dispatches')
        .select('recipient_id')
        .eq('recipient_id', r.id)
        .maybeSingle();

      const dispatchDate = faker.date.between({ from: '2026-07-08', to: '2026-07-15' });
      if (!existing) {
        await db.from('dispatches').insert({
          recipient_id: r.id,
          courier_name: faker.helpers.arrayElement(couriers),
          awb_number: faker.string.numeric(12),
          dispatch_date: dispatchDate.toISOString().slice(0, 10),
          created_by: adminId,
        });
      }
      await transitionStatus(db, { recipientId: r.id, from: r.status, to: 'dispatched', actorType: 'admin', actorId: adminId, payload: { via: 'finish' } });
      await logEvent(db, { recipientId: r.id, eventType: 'dispatch', actorType: 'admin', actorId: adminId, payload: { stage: 'dispatched' } });

      if (faker.number.int({ min: 1, max: 100 }) <= 85) {
        const deliveredDate = faker.date.between({ from: dispatchDate, to: '2026-07-20' });
        await db.from('dispatches').update({ delivered_date: deliveredDate.toISOString().slice(0, 10) }).eq('recipient_id', r.id);
        await transitionStatus(db, { recipientId: r.id, from: 'dispatched', to: 'delivered', actorType: 'admin', actorId: adminId });
        await logEvent(db, { recipientId: r.id, eventType: 'dispatch', actorType: 'admin', actorId: adminId, payload: { stage: 'delivered' } });
        await transitionStatus(db, { recipientId: r.id, from: 'delivered', to: 'delivery_confirm_pending', actorType: 'system' });
      }
    } catch (e) {
      console.warn(`  skip ${r0.id}: ${(e as Error).message}`);
    }
  }
}

async function deliveryConfirm(campaign: Campaign, skipPct = 15) {
  const { data: pend } = await db
    .from('recipients')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('status', 'delivery_confirm_pending');

  for (const r0 of (pend ?? []) as Recipient[]) {
    if (faker.number.int({ min: 1, max: 100 }) <= skipPct) continue;
    try {
      const r = await refresh(r0.id);
      if (!r || r.status !== 'delivery_confirm_pending') continue;
      const result = await provider.placeCall({
        recipientId: r.id,
        campaignId: campaign.id,
        callType: 'delivery_confirmation',
        languageConfig: campaign.language_config,
        defaultLanguage: campaign.default_language,
        retryLimit: campaign.retry_limit,
        skipMenuIfKnown: campaign.skip_menu_if_known,
        knownLanguage: r.preferred_language,
        productName: r.product_name,
      });
      await recordDeliveryConfirmationCall(db, r, campaign, result, 1, { actorType: 'ivr' });
    } catch (e) {
      console.warn(`  skip ${r0.id}: ${(e as Error).message}`);
    }
  }
}

async function main() {
  const { data: admin } = await db.from('profiles').select('id').eq('role', 'admin').limit(1).single();
  const adminId = admin!.id;
  const { data: campaigns } = await db.from('campaigns').select('*');

  for (const c of (campaigns ?? []) as Campaign[]) {
    console.log(`Finishing ${c.calling_from}…`);
    await dispatchAndDeliver(adminId, c.id);
    await deliveryConfirm(c);
  }

  const { data: statusRows } = await db.from('recipients').select('status');
  const counts: Record<string, number> = {};
  for (const s of statusRows ?? []) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const { count: vocs } = await db.from('voc_recordings').select('*', { count: 'exact', head: true });
  console.log('\n=== Finish complete ===');
  console.log('Status counts:', counts);
  console.log('Sealed VOCs:', vocs);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
