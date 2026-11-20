const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { fail } = require('./workspace');

function createProviders(env) {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
    LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AI_API_URL, AI_API_KEY, AI_MODEL } = env;
  const r2Origin = R2_ACCOUNT_ID && /^[a-f0-9]{32}$/i.test(R2_ACCOUNT_ID)
    ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
  const s3 = r2Origin && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY ? new S3Client({
    endpoint: r2Origin, region: 'auto', forcePathStyle: true,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  }) : null;
  const liveOrigin = LIVEKIT_URL?.startsWith('wss://') ? new URL(LIVEKIT_URL).origin : null;
  const roomService = liveOrigin && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? new RoomServiceClient(liveOrigin.replace(/^wss:/, 'https:'), LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : null;
  const aiUrl = AI_API_URL?.startsWith('https://') ? new URL(AI_API_URL) : null;

  const r2 = s3 && {
    origin: r2Origin,
    object: asset => ({ Bucket: R2_BUCKET, Key: (asset.receipt ? 'payment-slips/' : 'materials/') + asset.id }),
    upload(asset) {
      const command = new PutObjectCommand({ ...this.object(asset), ContentLength: Number(asset.size_bytes),
        ContentType: asset.mime, IfNoneMatch: '*' });
      return getSignedUrl(s3, command, { expiresIn: 1800,
        signableHeaders: new Set(['content-type', 'content-length', 'if-none-match']) });
    },
    async inspect(asset) {
      try {
        const result = await s3.send(new HeadObjectCommand(this.object(asset)), { abortSignal: AbortSignal.timeout(10000) });
        return { size: result.ContentLength, mime: result.ContentType };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) fail(409, 'The file has not arrived in storage yet.');
        fail(503, 'Storage could not verify the upload.');
      }
    },
    async fileHeader(asset) {
      try {
        const result = await s3.send(new GetObjectCommand({ ...this.object(asset), Range: 'bytes=0-11' }),
          { abortSignal: AbortSignal.timeout(10000) });
        return Buffer.from(await result.Body.transformToByteArray());
      } catch {
        fail(503, 'Storage could not verify the payment slip.');
      }
    },
    download(asset) {
      const inline = !asset.receipt && ['application/pdf', 'video/mp4', 'video/webm'].includes(asset.mime);
      const expiry = asset.receipt ? 120 : asset.mime.startsWith('video/') ? 15000 : 600;
      const remaining = asset.access_until ? Math.floor((Date.parse(asset.access_until) - Date.now()) / 1000) : expiry;
      if (remaining < 1) fail(402, 'Renew your access before opening the file.');
      const receiptExtensions = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      const disposition = asset.receipt ? 'attachment; filename="payment-slip.' + receiptExtensions[asset.mime] + '"' : inline ? 'inline' : 'attachment';
      return getSignedUrl(s3, new GetObjectCommand({ ...this.object(asset), ResponseContentType: asset.mime,
        ResponseContentDisposition: disposition }), { expiresIn: Math.min(expiry, remaining) });
    },
  };

  const live = roomService && {
    origin: liveOrigin,
    async token({ session, identity, name, host, access_until }) {
      const room = 'sls-' + session;
      const remaining = access_until ? Math.floor((Date.parse(access_until)-Date.now()) / 1000) : 120;
      if (remaining < 1) fail(402, 'Renew your access before joining the live class.');
      const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name, ttl: Math.min(120,remaining) });
      token.addGrant({ room, roomJoin: true, canPublish: host, canSubscribe: true, canPublishData: false });
      return { url: liveOrigin, token: await token.toJwt(), host, accessUntil: access_until };
    },
    async close(session) {
      try {
        await roomService.deleteRoom('sls-' + session);
      } catch (error) {
        if (error.status === 404 || error.code === 'not_found') return;
        fail(503, 'The live provider could not close the room. Try again.');
      }
    },
  };
  const ai = aiUrl && AI_API_KEY && AI_MODEL ? async (system, data) => {
    let response;
    try {
      response = await fetch(aiUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_API_KEY },
        redirect: 'error', signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 350,
          messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }] }),
      });
    } catch {
      fail(503, 'The AI provider is temporarily unavailable.');
    }
    if (!response.ok) fail(response.status === 429 ? 429 : 503, 'The AI provider could not answer right now.');
    const result = (await response.json().catch(() => null))?.choices?.[0]?.message?.content;
    if (typeof result !== 'string' || !result.trim()) fail(503, 'The AI provider returned an empty answer.');
    return result.trim().slice(0, 2500);
  } : null;
  return { r2, live, ai };
}

module.exports = { createProviders };
