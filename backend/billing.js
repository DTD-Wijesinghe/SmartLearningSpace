const { fail } = require('./workspace');

const receiptHeaders = {
  'application/pdf': b => b.subarray(0, 5).toString() === '%PDF-',
  'image/png': b => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  'image/jpeg': b => b.subarray(0, 3).toString('hex') === 'ffd8ff',
  'image/webp': b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
};

function paymentBank(env) {
  const { PLATFORM_BANK_HOLDER: holder, PLATFORM_BANK_NAME: bank, PLATFORM_BANK_BRANCH: branch, PLATFORM_BANK_ACCOUNT: account } = env;
  return holder && bank && branch && account ? { holder, bank, branch, account } : null;
}

function billing({ rpc, verify, r2, bank }) {
  return async (token, action, body) => {
    const invoke = (name, payload = body) => rpc(token, name, payload);
    if (action === 'read') {
      const state = await invoke(action);
      if (state.role === 'teacher' && !body.courseId) state.platformBank = bank;
      state.storage = Boolean(r2 && verify);
      return state;
    }
    if (['reserve','submit','open'].includes(action) && (!r2 || !verify)) fail(503, 'Payment slip storage is unavailable.');
    if (action === 'reserve') {
      if (!body.courseId && !bank) fail(503, 'Platform payment details have not been configured.');
      const slip = await invoke(action);
      return { id: slip.id, uploadUrl: await r2.upload({ ...slip, receipt: true }) };
    }
    if (action === 'submit') {
      const slip = { ...await invoke('inspect'), receipt: true };
      if (slip.status === 'pending') return { ok: true };
      const actual = await r2.inspect(slip);
      if (actual.size !== slip.size_bytes || actual.mime !== slip.mime
        || !receiptHeaders[slip.mime]?.(await r2.fileHeader(slip))) fail(409, 'The uploaded file does not match a supported payment slip.');
      if (!await verify({ slip_id: slip.id, payer_id: slip.payer })) fail(409, 'This upload has expired. Please upload a new slip.');
      return { ok: true };
    }
    if (action === 'open') {
      const slip = await invoke(action);
      return { url: await r2.download({ ...slip, receipt: true }) };
    }
    return invoke(action);
  };
}

module.exports = { billing, paymentBank };
