package com.nawabichai.ops;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

public class NCHFirebaseMessagingService extends FirebaseMessagingService {

    private static final String TAG = "NCHFirebase";
    private static final String CHANNEL_ID = "nch_orders";
    private static final String PREFS_NAME = "nch_ops_prefs";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        Log.d(TAG, "New FCM token: " + token);
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().putString("fcm_token", token).apply();
        sendTokenToServer(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Log.d(TAG, "FCM message received from: " + remoteMessage.getFrom());

        Map<String, String> data = remoteMessage.getData();
        String title = data.containsKey("title") ? data.get("title") : "NCH Order";
        String body = data.containsKey("body") ? data.get("body") : "You have a new notification";
        String tag = data.containsKey("tag") ? data.get("tag") : "nch_order_" + System.currentTimeMillis();
        String url = data.containsKey("url") ? data.get("url") : "/ops/";

        showAlarmNotification(title, body, tag, url);
    }

    private void showAlarmNotification(String title, String body, String tag, String url) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("notification_url", url);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, tag.hashCode(), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (alarmSound == null) {
            alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        }

        long[] vibrationPattern = {0, 1000, 300, 1000, 300, 1000, 300, 1000, 300,
                1000, 300, 1000, 300, 1000, 300, 1000, 300, 1000, 300, 1000};

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setSound(alarmSound, AudioManager.STREAM_ALARM)
                .setVibrate(vibrationPattern)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setDefaults(0)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setFullScreenIntent(pendingIntent, true);
        }

        NotificationManager notificationManager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (notificationManager != null) {
            notificationManager.notify(tag, 0, builder.build());
        }
    }

    private void sendTokenToServer(String fcmToken) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String authToken = prefs.getString("auth_token", null);
        String staffId = prefs.getString("staff_id", null);

        if (authToken == null || staffId == null) {
            Log.d(TAG, "No auth info yet, token will be sent on login");
            return;
        }

        new Thread(() -> {
            try {
                URL apiUrl = new URL("https://nawabichaihouse.com/api/hub?action=push-subscribe");
                HttpURLConnection conn = (HttpURLConnection) apiUrl.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Authorization", "Bearer " + authToken);
                conn.setDoOutput(true);

                String json = "{\"fcm_token\":\"" + fcmToken + "\",\"platform\":\"native\"}";
                OutputStream os = conn.getOutputStream();
                os.write(json.getBytes("UTF-8"));
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
