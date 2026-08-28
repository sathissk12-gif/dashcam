const JT808Server = require('./src/jt808/server');
const JT1078Server = require('./src/jt1078/server');
const DashcamSimulator = require('./src/simulator/dashcam_sim');

async function runTest() {
  console.log('=== Starting E2E Dashcam Backend Verification ===');

  const jt808 = new JT808Server({ port: 8098 });
  const jt1078 = new JT1078Server({ port: 1098 });

  await jt808.start();
  console.log('✔ JT808 Server started on port 8098');

  await jt1078.start();
  console.log('✔ JT1078 Server started on port 1098');

  let registered = false;
  let authenticated = false;
  let gpsReceived = false;
  let videoReceived = false;

  jt808.on('device_registered', (data) => {
    console.log(`✔ [Event] Device Registered: ${data.simNo}`);
    registered = true;
  });

  jt808.on('device_authenticated', (data) => {
    console.log(`✔ [Event] Device Authenticated: ${data.simNo}`);
    authenticated = true;
  });

  jt808.on('device_location', (data) => {
    if (!gpsReceived) {
      console.log(`✔ [Event] GPS Location Received: Lat: ${data.latitude}, Lng: ${data.longitude}, Speed: ${data.speedKmh} km/h, Sats: ${data.extras?.satellites}`);
      gpsReceived = true;

      console.log('▶ Sending 0x9101 Real-Time Video Request to Dashcam...');
      jt808.requestLiveVideo(data.simNo, {
        serverIp: '127.0.0.1',
        tcpPort: 1098,
        channel: 1,
        streamType: 0
      });
    }
  });

  jt1078.on('video_frame', (frame) => {
    if (!videoReceived) {
      console.log(`✔ [Event] JT1078 H.264 Video Frame Extracted! Channel: ${frame.channel}, Keyframe: ${frame.isKeyframe}, Size: ${frame.data.length} bytes`);
      videoReceived = true;

      setTimeout(() => {
        console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
        sim.stop();
        process.exit(0);
      }, 500);
    }
  });

  const sim = new DashcamSimulator({
    serverHost: '127.0.0.1',
    jt808Port: 8098,
    simNo: '013800138000'
  });

  sim.start();
}

runTest().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
