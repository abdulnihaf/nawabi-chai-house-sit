package com.nawabichai.ops;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

public class NCHFirebaseMessagingService extends FirebaseMessagingService {
    private static final String TAG = "NCHFcmService";
    private static final String CHANNEL_ID = "nch_orders";
    private static final String PREFS = "nch_prefs";

    @Override
    public void onNewToken(@NonNull String token) {
        Log.d(TAG, "New FCM token: " + token);
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString("fcm_token", token).apply();
        sendTokenToServer(token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Log.d(TAG, "FCM message received from: " + remoteMessage.getFrom());

        Map<String, String> data = remoteMessage.getData();
        if (data.isEmpty()) {
            Log.w(TAG, "Empty data payload, ignoring");
            return;
        }

        String title = data.containsKey("title") ? data.get("title") : "NCH Order";
        String body = data.containsKey("body") ? data.get("body") : "New order received";
        String tag = data.containsKey("tag") ? data.get("tag") : "nch_order";
        String url = data.containsKey("url") ? data.get("url") : "";

        showAlarmNotification(title, body, tag, url);
    }

    private void showAlarmNotification(String title, String body, String tag, String url) {
        Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (alarmSound == null) {
            alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        }

        long[] vibrationPattern = new long[]{
            0, 1000, 300, 1000, 300, 1000, 300, 1000, 300, 1000,
            300, 1000, 300, 1000, 300, 1000, 300, 1000, 300, 1000
        };

        // Intent to open the app (with optional deep link URL)
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (url != null && !url.isEmpty()) {
            intent.putExtra("push_url", url);
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, tag.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setSound(alarmSound, AudioManager.STREAM_ALARM)
                .setVibrate(vibrationPattern)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setFullScreenIntent(pendingIntent, true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        try {
            NotificationManagerCompat.from(this)
                    .notify(tag, tag.hashCode(), builder.build());
        } catch (SecurityException e) {
            Log.e(TAG, "Notification permission not granted", e);
        }
    }

    private void sendTokenToServer(String fcmToken) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String authToken = prefs.getString("auth_token", "");
        String staffId = prefs.getString("staff_id", "");

        if (authToken.isEmpty() || staffId.isEmpty()) {
            Log.d(TAG, "No auth info, skipping server token update");
            return;
        }

        // Send in background thread
        new Thread(() -> {
            try {
                URL url = new URL("https://nawabichaihouse.com/api/hub?action=push-subscribe");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Authorization", "Bearer " + authToken);
                conn.setDoOutput(true);

                String json = "{\"staff_id\":\"" + staffId + "\",\"fcm_token\":\"" + fcmToken + "\"}";
                OutputStream os = conn.getOutputStream();
                os.write(json.getBytes());
                os.close();

                int code = conn.getResponseCode();
                Log.d(TAG, "Token sent to server, response: " + code);
                conn.disconnect();
            } catch (Exception e) {
                Log.e(TAG, "Failed to send token to server", e);
            }
        }).start();
    }
}
