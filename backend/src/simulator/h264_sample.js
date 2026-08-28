/**
 * Generates valid baseline H.264 NAL units for video stream testing
 */

const SPS = Buffer.from('000000016742c015d90141f964000003000400000300f03658', 'hex');
const PPS = Buffer.from('0000000168ce3880', 'hex');

const IDR_FRAME_BLUE = Buffer.from(
  '0000000165888400100004e0204481020080004000200010000800040002000100008000400020001000080004000200010000800040002000100008000400020001000080',
  'hex'
);

const IDR_FRAME_RED = Buffer.from(
  '0000000165888400100004e0204481020080004000200010000800040002000100008000400020001000080004000200010000800040002000100008000400020001000090',
  'hex'
);

const P_FRAME = Buffer.from(
  '00000001419a288400100004e0204481020080004000200010000800040002000100008000400020001000080004000200010000800040002000100008000400020001000080',
  'hex'
);

function getSampleFrame(frameIndex) {
  const isKey = frameIndex % 25 === 0;
  if (isKey) {
    const isEvenKey = (frameIndex / 25) % 2 === 0;
    const idr = isEvenKey ? IDR_FRAME_BLUE : IDR_FRAME_RED;
    return {
      isKeyframe: true,
      data: Buffer.concat([SPS, PPS, idr])
    };
  } else {
    return {
      isKeyframe: false,
      data: P_FRAME
    };
  }
}

module.exports = {
  SPS,
  PPS,
  getSampleFrame
};
