const fs = require('fs');

const targetFile = 'C:/Users/sathi/Desktop/projects/Master Code of Crm and APP/Traxen_App/TRACKSPHERE-app-main/lib/features/customer/features/dashcam/presentation/pages/dashcam_vehicles_page.dart';

if (fs.existsSync(targetFile)) {
  let code = fs.readFileSync(targetFile, 'utf8');

  const fallbackBlock = `
  static final List<DashcamVehicle> _fallbackDevices = [
    const DashcamVehicle(
      id: 'veh_015770054447',
      numberPlate: 'TN 38 AB 1234',
      simNo: '015770054447',
      model: 'T98 NON-AI 4G Dual-Cam',
      driverName: 'Driver 1',
      driverPhone: '+91 98765 43210',
      assignedUserId: 'user_cust_1',
      assignedUserName: 'Customer One',
      assignedUserPhone: '+91 98765 43210',
      channelCount: 2,
      channels: [
        DashcamChannelConfig(id: 1, name: 'Channel 1 (Front Road)', enabled: true),
        DashcamChannelConfig(id: 2, name: 'Channel 2 (Cabin / Driver)', enabled: true),
      ],
      isOnline: true,
      isDeviceConnected: true,
      telemetry: DashcamTelemetry(
        latitude: 11.295318,
        longitude: 77.737556,
        speed: 0.0,
        course: 0.0,
        altitude: 280.0,
        acc: true,
        address: 'Coimbatore, Tamil Nadu',
      ),
    ),
    const DashcamVehicle(
      id: 'veh_015770060120',
      numberPlate: 'TN 37 XY 4567',
      simNo: '015770060120',
      model: 'T98 NON-AI 4G Dual-Cam',
      driverName: 'Driver 2',
      driverPhone: '+91 98765 43211',
      assignedUserId: 'user_cust_2',
      assignedUserName: 'Customer Two',
      assignedUserPhone: '+91 98765 43211',
      channelCount: 2,
      channels: [
        DashcamChannelConfig(id: 1, name: 'Channel 1 (Front Road)', enabled: true),
        DashcamChannelConfig(id: 2, name: 'Channel 2 (Cabin / Driver)', enabled: true),
      ],
      isOnline: true,
      isDeviceConnected: true,
      telemetry: DashcamTelemetry(
        latitude: 11.016844,
        longitude: 76.955833,
        speed: 0.0,
        course: 0.0,
        altitude: 350.0,
        acc: true,
        address: 'Gandhipuram, Coimbatore',
      ),
    ),
  ];
`;

  // Remove existing broken _fallbackDevices if any
  const match = code.match(/static final List<DashcamVehicle> _fallbackDevices = \[[\s\S]*?\];\n/);
  if (match) {
    code = code.replace(match[0], '');
  }

  code = code.replace(
    'class _DashcamVehiclesPageState extends State<DashcamVehiclesPage> {',
    'class _DashcamVehiclesPageState extends State<DashcamVehiclesPage> {' + fallbackBlock
  );

  fs.writeFileSync(targetFile, code, 'utf8');
  console.log('Successfully written corrected Flutter dashcam_vehicles_page.dart');
}
