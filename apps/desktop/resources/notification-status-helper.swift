import Foundation
import UserNotifications

let helperStatusEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS"
let helperStatusFileEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_STATUS_FILE"
let helperRequestResultEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_REQUEST_RESULT"
let helperFollowsRequestEnv = "PI_APP_TEST_NOTIFICATION_PERMISSION_HELPER_FOLLOWS_REQUEST"

struct HelperOutput: Encodable {
    let status: String
}

func normalizeStatus(_ value: String?) -> String? {
    switch value {
    case "granted", "denied", "default", "unsupported", "unknown":
        return value
    default:
        return nil
    }
}

func mapAuthorizationStatus(_ value: UNAuthorizationStatus) -> String {
    switch value {
    case .notDetermined:
        return "default"
    case .denied:
        return "denied"
    case .authorized, .provisional, .ephemeral:
        return "granted"
    @unknown default:
        return "unknown"
    }
}

func emit(_ output: HelperOutput) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try! encoder.encode(output)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(EXIT_SUCCESS)
}

let arguments = CommandLine.arguments
let environment = ProcessInfo.processInfo.environment

if arguments.contains("--request") {
    if let overrideStatus = normalizeStatus(environment[helperRequestResultEnv]) {
        if environment[helperFollowsRequestEnv] == "1",
           let statusFilePath = environment[helperStatusFileEnv],
           !statusFilePath.isEmpty {
            try? "\(overrideStatus)\n".write(toFile: statusFilePath, atomically: true, encoding: .utf8)
        }
        emit(HelperOutput(status: overrideStatus))
    }

    let semaphore = DispatchSemaphore(value: 0)
    var resolvedOutput = HelperOutput(status: "unknown")
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            resolvedOutput = HelperOutput(status: mapAuthorizationStatus(settings.authorizationStatus))
            semaphore.signal()
        }
    }

    _ = semaphore.wait(timeout: .now() + .seconds(5))
    emit(resolvedOutput)
}

if let overrideStatus = normalizeStatus(environment[helperStatusEnv]) {
    emit(HelperOutput(status: overrideStatus))
}

if let statusFilePath = environment[helperStatusFileEnv],
   !statusFilePath.isEmpty,
   let fileContents = try? String(contentsOfFile: statusFilePath, encoding: .utf8),
   let fileStatus = normalizeStatus(fileContents.trimmingCharacters(in: .whitespacesAndNewlines)) {
    emit(HelperOutput(status: fileStatus))
}

let semaphore = DispatchSemaphore(value: 0)
var resolvedOutput = HelperOutput(status: "unknown")

UNUserNotificationCenter.current().getNotificationSettings { settings in
    resolvedOutput = HelperOutput(status: mapAuthorizationStatus(settings.authorizationStatus))
    semaphore.signal()
}

_ = semaphore.wait(timeout: .now() + .seconds(5))
emit(resolvedOutput)
