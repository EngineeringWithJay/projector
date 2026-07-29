'use strict';

const { Identity } = require('hyperframe');

/**
 * DeviceIdentity — Profile setup, login/logout.
 * Uses runtime/identity.js + runtime/context.js for persistence.
 */

/**
 * Set the local profile (peer name, optional avatar).
 */
function setLocalProfile(ctx, { label, avatar = null }) {
  if (!label || typeof label !== 'string' || !label.trim()) {
    throw new Error('Profile label is required.');
  }
  ctx.identity.deviceLabel = label.trim().slice(0, 40);
  if (avatar !== undefined) ctx.identity.deviceAvatar = avatar;
  ctx.identity.profileSetupComplete = true;
  return { label: ctx.identity.deviceLabel, avatar: ctx.identity.deviceAvatar };
}

/**
 * Login with a private key (device recovery).
 */
function login(ctx, { privateKey }) {
  if (!privateKey || typeof privateKey !== 'string') {
    throw new Error('Private key is required for login.');
  }
  // In a real implementation this would derive identity from the private key.
  // For now, just mark as logged in with the provided key.
  ctx.identity.devicePrivateKey = privateKey.trim();
  ctx.identity.profileSetupComplete = true;
  return { deviceId: ctx.identity.deviceId };
}

/**
 * Logout — clear profile setup state but keep identity.
 */
function logout(ctx) {
  ctx.identity.profileSetupComplete = false;
  ctx.identity.deviceLabel = '';
  ctx.identity.deviceAvatar = null;
}

/**
 * Reset identity completely (nuclear option — wipe corestore, new keypair).
 */
async function resetIdentity(ctx) {
  await ctx.swarm.destroy();
  await ctx.controlPlane.close();
  await ctx.dataPlane.close();
  await ctx.messagePlane.close();
  await ctx.storage.wipe();
  const newIdentity = Identity.loadOrCreateIdentity({});
  Object.assign(ctx.identity, newIdentity);
  return { deviceId: ctx.identity.deviceId };
}

/**
 * Reset profile — keep identity but clear label/avatar setup.
 */
function resetProfile(ctx) {
  ctx.identity.profileSetupComplete = false;
  ctx.identity.deviceLabel = '';
  ctx.identity.deviceAvatar = null;
}

module.exports = { setLocalProfile, login, logout, resetIdentity, resetProfile };
