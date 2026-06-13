-- Add instagram_handle to watched_studios so the corpus harvester can
-- pull recent posts directly from Instagram's profile API (no auth needed
-- for public accounts).
--
-- Handles verified via the Instagram web_profile_info endpoint.
-- Studios with no confirmed handle are left null — the harvester skips them.

alter table public.watched_studios
  add column if not exists instagram_handle text default null;

create index if not exists watched_studios_ig_idx
  on public.watched_studios (instagram_handle)
  where instagram_handle is not null;

-- ---------------------------------------------------------------------------
-- Seed: type foundries (verified handles)
-- ---------------------------------------------------------------------------
update public.watched_studios set instagram_handle = 'klim_type_foundry' where domain = 'klim.co.nz';
update public.watched_studios set instagram_handle = 'abcdinamo'         where domain = 'abcdinamo.com';
update public.watched_studios set instagram_handle = 'commercialtype'    where domain = 'commercialtype.com';
update public.watched_studios set instagram_handle = 'grillitype'        where domain = 'grillitype.com';
update public.watched_studios set instagram_handle = 'colophonfoundry'   where domain = 'colophon-foundry.org';
update public.watched_studios set instagram_handle = 'sharptype'         where domain = 'sharptype.co';
update public.watched_studios set instagram_handle = 'pangrampangram'    where domain = 'pangrampangram.com';
update public.watched_studios set instagram_handle = 'blazetype'         where domain = 'blazetype.eu';
update public.watched_studios set instagram_handle = 'futurefonts'       where domain = 'futurefonts.xyz';
update public.watched_studios set instagram_handle = 'typotheque'        where domain = 'typotheque.com';
update public.watched_studios set instagram_handle = 'lineto'            where domain = 'lineto.com';
update public.watched_studios set instagram_handle = 'swisstypefaces'    where domain = 'swisstypefaces.com';
update public.watched_studios set instagram_handle = '205tf'             where domain = '205.tf';
update public.watched_studios set instagram_handle = 'typemates'         where domain = 'typemates.com';
update public.watched_studios set instagram_handle = 'fontwerk'          where domain = 'fontwerk.com';
update public.watched_studios set instagram_handle = 'massdriver'        where domain = 'mass-driver.com';
update public.watched_studios set instagram_handle = 'vjtype'            where domain = 'vj-type.com';
update public.watched_studios set instagram_handle = 'dstype'            where domain = 'dstype.com';
-- ohnotype.co, optimo.ch, displaay.net, atipofoundry.com — handles unconfirmed, left null

-- ---------------------------------------------------------------------------
-- Seed: design agencies (verified handles)
-- ---------------------------------------------------------------------------
update public.watched_studios set instagram_handle = 'pentagram'          where domain = 'pentagram.com';
update public.watched_studios set instagram_handle = 'kotostudio'         where domain = 'koto.studio';
update public.watched_studios set instagram_handle = 'basicagency'        where domain = 'basicagency.com';
update public.watched_studios set instagram_handle = 'workandco'          where domain = 'work.co';
update public.watched_studios set instagram_handle = 'dixonbaxi'          where domain = 'dixonbaxi.com';
update public.watched_studios set instagram_handle = 'metalab'            where domain = 'metalab.com';
update public.watched_studios set instagram_handle = 'area17'             where domain = 'area17.com';
update public.watched_studios set instagram_handle = 'locomotive_agency'  where domain = 'locomotive.ca';
update public.watched_studios set instagram_handle = 'dogstudio'          where domain = 'dogstudio.co';
update public.watched_studios set instagram_handle = 'activetheory'       where domain = 'activetheory.net';
-- instrument.com, resn.co.nz, 14islands.com, humaan.com, buildinamsterdam.com,
-- basement.studio, phantom.land, unseen.co, makemepulse.com, hellomonday.com
-- — rate-limited during verification, left null to fill in later
