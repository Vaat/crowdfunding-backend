drop table if exists "postfinancePayments";
drop table if exists "cashPayments";
drop table if exists "paymentSources";
drop table if exists "pledgePayments";
drop table if exists "payments";
drop table if exists "pledgeOptions";
drop table if exists "memberships";
drop table if exists "pledges";
drop table if exists "membershipTypes";
drop table if exists "goodies";
drop table if exists "packageOptions";
drop table if exists "rewards";
drop table if exists "packages";
drop table if exists "crowdfundings";
drop function if exists make_hrid(regclass, text, bigint);
drop type  if exists "paymentType";
drop type  if exists "paymentStatus";
drop type  if exists "paymentMethod";
drop type  if exists "pledgeStatus";
drop type  if exists "rewardType";

drop function if exists voucher_code_trigger_function();
drop trigger if exists trigger_voucher_code ON memberships;
