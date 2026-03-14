package com.nawabichai.ops;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.BridgeActivity;
import com.google.firebase.messaging.FirebaseMessaging;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "NCHMainActivity";
    private static final String PREFS = "nch_prefs";
    private static final String CHANNEL_ID = "nch_orders";
    private String fcmToken = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        createNotificationChannel();
        requestAllPermissions();
        setupBackNavigation();

        // Delay bridge injection until WebView is ready
        getBridge().getWebView().post(() -> {
            exposeJsBridge();
            getFcmTokenAndInject();
        });
    }

    private void createNotificationChannel() {
        Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (alarmSound == null) {
            alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        }

        long[] vibrationPattern = new long[]{
            0, 1000, 300, 1000, 300, 1000, 300, 1000, 300, 1000,
            300, 1000, 300, 1000, 300, 1000, 300, 1000, 300, 1000
        };

        NotificationChannelCompat channel = new NotificationChannelCompat.Builder(
                CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_HIGH)
                .setName("NCH Orders")
                .setDescription("Order alerts that ring like an alarm")
                .setSound(alarmSound, null)
                .setVibrationEnabled(true)
                .setVibrationPattern(vibrationPattern)
                .build();

        NotificationManagerCompat.from(this).createNotificationChannel(channel);

        // Set bypass DND on the actual NotificationChannel (requires API 26+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            android.app.NotificationChannel nc =
                    ((android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                            .getNotificationChannel(CHANNEL_ID);
            if (nc != null) {
                nc.setBypassDnd(true);
            }
        }
    }

    private void requestAllPermissions() {
        // Notification permission (Android 13+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ActivityCompat.requestPermissions(this,
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 100);
        }

        // Battery optimization exemption
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            }
        }
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = getBridge().getWebView();
                if (wv.canGoBack()) {
                    wv.goBack();
                } else {
                    // At hub — minimize app instead of closing
                    moveTaskToBack(true);
                }
            }
        });
    }

    private void getFcmTokenAndInject() {
        FirebaseMessaging.getInstance().getToken()
                .addOnCompleteListener(task -> {
                    if (!task.isSuccessful()) {
                        Log.w(TAG, "FCM token fetch failed", task.getException());
                        return;
                    }
                    fcmToken = task.getResult();
                    Log.d(TAG, "FCM Token: " + fcmToken);

                    // Store in SharedPreferences
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString("fcm_token", fcmToken).apply();

                    // Inject into WebView
                    WebView wv = getBridge().getWebView();
                    wv.post(() -> {
                        String js = "window.nativeFcmToken='" + fcmToken.replace("'", "\\'") + "';" +
                                "window.dispatchEvent(new CustomEvent('fcmTokenReady',{detail:'" +
                                fcmToken.replace("'", "\\'") + "'}));";
                        wv.evaluateJavascript(js, null);
                    });
                });
    }

    private void exposeJsBridge() {
        getBridge().getWebView().addJavascriptInterface(new NCHJsBridge(), "NCHNative");
    }

    class NCHJsBridge {
        @JavascriptInterface
        public String getFcmToken() {
            if (!fcmToken.isEmpty()) return fcmToken;
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString("fcm_token", "");
        }

        @JavascriptInterface
        public void setAuthInfo(String token, String staffId) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString("auth_token", token)
                    .putString("staff_id", staffId)
                    .apply();
        }

        @JavascriptInterface
        public String getAuthToken() {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString("auth_token", "");
        }

        @JavascriptInterface
        public String getStaffId() {
            return getSharedPreferences(PREFS, MODE_PRIVATE).getString("staff_id", "");
        }

        @JavascriptInterface
        public void clearAuth() {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .remove("auth_token")
                    .remove("staff_id")
                    .apply();
        }
    }
}
