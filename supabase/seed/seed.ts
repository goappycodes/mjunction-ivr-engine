/**
 * Deterministic demo seed (TECH_SPEC §11).
 *   npm run seed
 *
 * Creates admin + telecaller users, languages (already in migration), 3
 * campaigns with a few hundred recipients, and runs a FULL mock lifecycle for
 * campaign 1 (import -> order-confirm -> dispatch -> delivered -> delivery-
 * confirm/VOC) so dashboards, queues, the VOC vault and exports are populated.
 * Idempotent: wipes prior demo campaigns first.
 */
import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fakerEN_IN as faker } from '@faker-js/faker';

import type { Campaign, Database, Recipient } from '../../src/lib/database.types';
import { MockTelephonyProvider } from '../../src/lib/telephony/mock-provider';
import {
  recordOrderConfirmationCall,
  recordDeliveryConfirmationCall,
} from '../../src/lib/domain/call-flow';
import { transitionStatus, logEvent } from '../../src/lib/domain/audit';
import { ORDER_CALLABLE } from '../../src/lib/domain/status';

loadEnv({ path: '.env.local' });
faker.seed(20260722);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const db = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const provider = new MockTelephonyProvider(db);

const USERS = [
  { email: 'admin@mjunction.test', password: 'Admin@12345', full_name: 'Priya Admin', role: 'admin' as const },
  { email: 'mjunction@appycodes.com', password: 'Admin@12345', full_name: 'mjunction Admin', role: 'admin' as const },
  { email: 'ops@mjunction.test', password: 'Admin@12345', full_name: 'Sneha Operations', role: 'admin' as const },
  { email: 'agent@mjunction.test', password: 'Agent@12345', full_name: 'Ravi Telecaller', role: 'telecaller' as const },
  { email: 'agent2@mjunction.test', password: 'Agent@12345', full_name: 'Meera Kulkarni', role: 'telecaller' as const },
  { email: 'agent3@mjunction.test', password: 'Agent@12345', full_name: 'Arjun Reddy', role: 'telecaller' as const },
];

const PRODUCTS = [
  'Prestige Induction Cooktop',
  'Bajaj Mixer Grinder',
  'Milton Steel Flask Set',
  'Philips LED Emergency Light',
  'Havells Ceiling Fan',
  'Prestige Pressure Cooker 5L',
  'Wonderchef Nutri-Blend',
  'Usha Steam Iron',
];

type SeedUser = { id: string; role: string };

async function ensureUsers(): Promise<Record<string, SeedUser>> {
  const out: Record<string, SeedUser> = {};
  for (const u of USERS) {
    const created = await db.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
      user_metadata: { full_name: u.full_name, role: u.role },
    });
    let id = created.data.user?.id;
    if (!id) {
      // Already exists — find it.
      const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
      id = data.users.find((x) => x.email === u.email)?.id;
    }
    if (!id) throw new Error(`Could not ensure user ${u.email}`);
    // Ensure profile + role (trigger sets it on create; enforce on re-run).
    await db.from('profiles').upsert({ id, full_name: u.full_name, role: u.role });
    out[u.email] = { id, role: u.role };
    console.log(`  user ${u.email} (${u.role}) -> ${id}`);
  }
  return out;
}

async function emptyVocBucket() {
  // Best-effort recursive delete of our {campaign}/{recipient}/{file} layout.
  const { data: campaigns } = await db.storage.from('voc').list('', { limit: 1000 });
  for (const c of campaigns ?? []) {
    if (!c.name) continue;
    const { data: recips } = await db.storage.from('voc').list(c.name, { limit: 1000 });
    const paths: string[] = [];
    for (const r of recips ?? []) {
      const { data: files } = await db.storage
        .from('voc')
        .list(`${c.name}/${r.name}`, { limit: 1000 });
      for (const f of files ?? []) paths.push(`${c.name}/${r.name}/${f.name}`);
    }
    if (paths.length) await db.storage.from('voc').remove(paths);
  }
}

async function wipeDemo() {
  console.log('Wiping prior demo data…');
  await emptyVocBucket();
  const { data: campaigns } = await db.from('campaigns').select('id');
  for (const c of campaigns ?? []) {
    // voc_recordings FKs are intentionally non-cascading ("retained
    // indefinitely"), so clear them first or the campaign delete is blocked.
    await db.from('voc_recordings').delete().eq('campaign_id', c.id);
    const { error } = await db.from('campaigns').delete().eq('id', c.id);
    if (error) console.warn(`  wipe: could not delete campaign ${c.id}: ${error.message}`);
  }
}

async function createCampaign(
  adminId: string,
  input: Partial<Campaign> & { calling_from: string },
): Promise<Campaign> {
  const { data, error } = await db
    .from('campaigns')
    .insert({
      calling_from: input.calling_from,
      order_reference: input.order_reference ?? null,
      start_date: input.start_date ?? '2026-07-01',
      end_date: input.end_date ?? '2026-08-31',
      default_language: input.default_language ?? 'hi',
      retry_limit: input.retry_limit ?? 2,
      skip_menu_if_known: input.skip_menu_if_known ?? false,
      language_config: input.language_config ?? [
        { dtmf: '1', lang: 'hi' },
        { dtmf: '2', lang: 'en' },
      ],
      created_by: adminId,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as Campaign;
}

let phoneSeq = 9700000000;

async function createRecipients(
  campaign: Campaign,
  adminId: string,
  count: number,
  withDeliveryDate: boolean,
): Promise<Recipient[]> {
  const { data: batch } = await db
    .from('import_batches')
    .insert({
      campaign_id: campaign.id,
      file_name: `${campaign.calling_from.replace(/\s+/g, '_')}_import.xlsx`,
      row_count: count,
      valid_count: count,
      error_count: 0,
      duplicate_count: 0,
      uploaded_by: adminId,
    })
    .select('id')
    .single();

  const rows = Array.from({ length: count }).map(() => {
    const e164 = `+91${phoneSeq++}`;
    const missingAddress = faker.number.int({ min: 1, max: 100 }) <= 4;
    return {
      campaign_id: campaign.id,
      calling_from: campaign.calling_from,
      telecaller_name: faker.person.fullName(),
      contact_no: e164.replace('+91', ''),
      contact_no_e164: e164,
      customer_name: faker.person.fullName(),
      address: missingAddress
        ? null
        : `${faker.location.streetAddress()}, ${faker.location.city()}, ${faker.location.state()} ${faker.location.zipCode('######')}`,
      product_name: faker.helpers.arrayElement(PRODUCTS),
      product_delivery_date: withDeliveryDate
        ? faker.date.between({ from: '2026-07-05', to: '2026-07-20' }).toISOString().slice(0, 10)
        : null,
      status: 'imported' as const,
      missing_address: missingAddress,
      missing_product: false,
      dedupe_key: `${campaign.id}:${e164}`,
      import_batch_id: batch?.id ?? null,
    };
  });

  const { data, error } = await db.from('recipients').insert(rows).select('*');
  if (error) throw new Error(error.message);

  for (const r of data as Recipient[]) {
    await logEvent(db, {
      recipientId: r.id,
      eventType: 'imported',
      actorType: 'admin',
      actorId: adminId,
      payload: { import_batch_id: batch?.id, campaign_id: campaign.id },
    });
  }
  return data as Recipient[];
}

async function refresh(id: string): Promise<Recipient> {
  const { data } = await db.from('recipients').select('*').eq('id', id).single();
  return data as Recipient;
}

async function runOrderConfirmBatch(campaign: Campaign, recipients: Recipient[], adminId: string) {
  for (const r0 of recipients) {
    try {
      const r = await refresh(r0.id);
      // Only call recipients still in an order-callable state (robust to
      // concurrent app usage while the seed runs).
      if (!ORDER_CALLABLE.includes(r.status)) continue;
      const result = await provider.placeCall({
        recipientId: r.id,
        campaignId: campaign.id,
        callType: 'order_confirmation',
        languageConfig: campaign.language_config,
        defaultLanguage: campaign.default_language,
        retryLimit: campaign.retry_limit,
        skipMenuIfKnown: campaign.skip_menu_if_known,
        knownLanguage: r.preferred_language,
        productName: r.product_name,
      });
      await recordOrderConfirmationCall(db, r, campaign, result, 1, { actorType: 'ivr' });
    } catch (e) {
      console.warn(`  order-confirm skip ${r0.id}: ${(e as Error).message}`);
    }
  }
}

async function resolveSomeEscalations(campaign: Campaign, adminId: string, agentId: string) {
  // Agent manually resolves ~60% of order-confirm escalations (corrected address).
  const { data: pend } = await db
    .from('recipients')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('status', 'order_confirm_pending');
  for (const r of (pend ?? []) as Recipient[]) {
    // Only those whose last call was a press-2 transfer are true escalations.
    const { data: lastCall } = await db
      .from('call_attempts')
      .select('*')
      .eq('recipient_id', r.id)
      .eq('call_type', 'order_confirmation')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (lastCall?.outcome !== 'transferred_to_agent') continue;
    if (faker.number.int({ min: 1, max: 100 }) > 60) continue; // leave 40% open

    const corrected = `${faker.location.streetAddress()}, ${faker.location.city()}, ${faker.location.state()} ${faker.location.zipCode('######')}`;
    await db.from('recipients').update({ address: corrected, updated_at: new Date().toISOString() }).eq('id', r.id);
    await db.from('call_attempts').insert({
      recipient_id: r.id,
      campaign_id: campaign.id,
      call_type: 'order_confirmation',
      attempt_number: 2,
      provider: 'mock',
      caller_type: 'agent',
      agent_id: agentId,
      language: r.preferred_language,
      outcome: 'corrected',
      agent_note: 'Corrected address captured by agent (human, not STT).',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    });
    await logEvent(db, {
      recipientId: r.id,
      eventType: 'edit',
      actorType: 'agent',
      actorId: agentId,
      payload: { field: 'address', reason: 'escalation_resolved' },
    });
    await transitionStatus(db, {
      recipientId: r.id,
      from: 'order_confirm_pending',
      to: 'address_corrected',
      actorType: 'agent',
      actorId: agentId,
    });
  }
}

async function dispatchAndDeliver(campaign: Campaign, adminId: string) {
  const { data: confirmed } = await db
    .from('recipients')
    .select('*')
    .eq('campaign_id', campaign.id)
    .in('status', ['address_confirmed', 'address_corrected']);

  const couriers = ['Delhivery', 'Blue Dart', 'DTDC', 'Ekart', 'XpressBees'];
  for (const r of (confirmed ?? []) as Recipient[]) {
    try {
      if (r.status !== 'address_confirmed' && r.status !== 'address_corrected') continue;
      const dispatchDate = faker.date.between({ from: '2026-07-08', to: '2026-07-15' });
      await db.from('dispatches').insert({
        recipient_id: r.id,
        courier_name: faker.helpers.arrayElement(couriers),
        awb_number: faker.string.numeric(12),
        dispatch_date: dispatchDate.toISOString().slice(0, 10),
        delivered_date: null,
        created_by: adminId,
      });
      await transitionStatus(db, { recipientId: r.id, from: r.status, to: 'dispatched', actorType: 'admin', actorId: adminId });
      await logEvent(db, { recipientId: r.id, eventType: 'dispatch', actorType: 'admin', actorId: adminId, payload: { stage: 'dispatched' } });

      // ~88% get delivered, feeding the delivery-confirm queue.
      if (faker.number.int({ min: 1, max: 100 }) <= 88) {
        const deliveredDate = faker.date.between({ from: dispatchDate, to: '2026-07-20' });
        await db.from('dispatches').update({ delivered_date: deliveredDate.toISOString().slice(0, 10) }).eq('recipient_id', r.id);
        await transitionStatus(db, { recipientId: r.id, from: 'dispatched', to: 'delivered', actorType: 'admin', actorId: adminId });
        await logEvent(db, { recipientId: r.id, eventType: 'dispatch', actorType: 'admin', actorId: adminId, payload: { stage: 'delivered' } });
        // Auto-enqueue for delivery confirmation.
        await transitionStatus(db, { recipientId: r.id, from: 'delivered', to: 'delivery_confirm_pending', actorType: 'system' });
      }
    } catch (e) {
      console.warn(`  dispatch skip ${r.id}: ${(e as Error).message}`);
    }
  }
}

async function runDeliveryConfirmBatch(campaign: Campaign, skipPct = 15) {
  const { data: pend } = await db
    .from('recipients')
    .select('*')
    .eq('campaign_id', campaign.id)
    .eq('status', 'delivery_confirm_pending');

  for (const r0 of (pend ?? []) as Recipient[]) {
    // Leave a slice un-called so the delivery-confirm queue is never empty.
    if (faker.number.int({ min: 1, max: 100 }) <= skipPct) continue;
    try {
      const r = await refresh(r0.id);
      if (r.status !== 'delivery_confirm_pending') continue;
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
      console.warn(`  delivery-confirm skip ${r0.id}: ${(e as Error).message}`);
    }
  }
}

async function main() {
  console.log('Ensuring users…');
  const users = await ensureUsers();
  const adminId = users['admin@mjunction.test'].id;
  const agentId = users['agent@mjunction.test'].id;

  await wipeDemo();

  console.log('Creating campaigns…');
  const c1 = await createCampaign(adminId, {
    calling_from: 'Tata Steel Dealer Rewards',
    order_reference: 'ORD-TS-2026-07',
    default_language: 'hi',
    language_config: [
      { dtmf: '1', lang: 'hi' },
      { dtmf: '2', lang: 'en' },
    ],
  });
  const c2 = await createCampaign(adminId, {
    calling_from: 'JSW Retailer Gifting',
    order_reference: 'ORD-JSW-2026-07',
    default_language: 'hi',
    skip_menu_if_known: true,
    language_config: [
      { dtmf: '1', lang: 'hi' },
      { dtmf: '2', lang: 'en' },
      { dtmf: '3', lang: 'bn' },
    ],
  });
  const c3 = await createCampaign(adminId, {
    calling_from: 'mjunction Q3 Loyalty',
    order_reference: 'ORD-MJ-2026-07',
    default_language: 'en',
    language_config: [
      { dtmf: '1', lang: 'en' },
      { dtmf: '2', lang: 'hi' },
    ],
  });

  console.log('Creating recipients…');
  const r1 = await createRecipients(c1, adminId, 120, true);
  const r2 = await createRecipients(c2, adminId, 80, true);
  const r3 = await createRecipients(c3, adminId, 60, true);

  // Run the FULL lifecycle for every campaign so each tab (recipients, calls,
  // dispatch, VOC vault, reports) and every queue is populated everywhere.
  async function fullLifecycle(c: Campaign, recips: Recipient[], label: string) {
    console.log(`${label}: full lifecycle…`);
    await runOrderConfirmBatch(c, recips, adminId);
    await resolveSomeEscalations(c, adminId, agentId);
    await dispatchAndDeliver(c, adminId);
    await runDeliveryConfirmBatch(c);
  }

  await fullLifecycle(c1, r1, 'Campaign 1 (Tata Steel)');
  await fullLifecycle(c2, r2, 'Campaign 2 (JSW)');
  await fullLifecycle(c3, r3, 'Campaign 3 (mjunction)');

  // Summary
  const { data: statusRows } = await db.from('recipients').select('status');
  const counts: Record<string, number> = {};
  for (const s of statusRows ?? []) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const { count: vocCount } = await db.from('voc_recordings').select('*', { count: 'exact', head: true });

  console.log('\n=== Seed complete ===');
  console.log('Recipient status counts:', counts);
  console.log('Sealed VOCs:', vocCount);
  console.log('\nLogin credentials:');
  console.log('  ADMIN      admin@mjunction.test / Admin@12345');
  console.log('  ADMIN      mjunction@appycodes.com / Admin@12345');
  console.log('  ADMIN      ops@mjunction.test / Admin@12345');
  console.log('  TELECALLER agent@mjunction.test / Agent@12345');
  console.log('  TELECALLER agent2@mjunction.test / Agent@12345');
  console.log('  TELECALLER agent3@mjunction.test / Agent@12345');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
