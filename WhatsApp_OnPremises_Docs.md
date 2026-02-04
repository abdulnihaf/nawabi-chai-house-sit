# WhatsApp On-Premises API Documentation
*Source: https://developers.facebook.com/docs/whatsapp/on-premises*

This document contains the scraped text data from the links listed on the main landing page.

---

# Webhooks for the On-Premises API
Subscribe to Webhooks to get notifications about messages your business receives and customer profile updates. See [Overview, Webhooks](https://developers.facebook.com/docs/whatsapp/overview/webhooks) for more information on WhatsApp Business Platform webhooks.
Webhooks set up will not affect the phone number on your WhatsApp Business App. Only after you [migrate your number over to the WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/overview/phone-number#migrate) can you no longer use that number on your WhatsApp Business App.

## Before You Start
You will need:
- Code that supports HTTPS and has a valid SSL certificate
- A callback URL endpoint that is configured to accept inbound requests from the Coreapp 
- A callback URL endpoint that returns an HTTPS 200 OK response when a notification is received

```
HTTPS 200 OK
```

### Retry
If a notification isn't delivered for any reason or if the webhook request returns a HTTP status code other than 200, we retry delivery. We continue retrying delivery with increasing delays up to a certain timeout (typically 24 hours, though this may vary), or until the delivery succeeds.

```
200
```

## Set Your Callback URL Endpoint
Send a PATCH request to the the /v1/settings/application endpoint with the webhooks parameter set to your callback URL endpoint. Other commonly configured parameters are sent_status and callback_persist.

```
PATCH
```


```
/v1/settings/application
```


```
webhooks
```


```
sent_status
```


```
callback_persist
```

### Example Request
```
PATCH /v1/settings/application { "callback_persist": true, "sent_status": true, // Either use this or webhooks.message.sent, but webhooks.message.sent property is preferred as sent_status will be deprecated soon "webhooks": { "url": "webhook.your-domain", "message": { // Available on v2.41.2 and above "sent": false, "delivered": true, "read": false }, } }
```

On success, the response contains 200 OK with a null or a JSON object.

```
200 OK
```


```
null
```

Visit the [Application Settings Reference](https://developers.facebook.com/docs/whatsapp/on-premises/reference/settings/app#parameters) for more information about configuring your app, and additional webhooks parameters.

## Webhook Notification Payload
Whenever a trigger event occurs, the WhatsApp Business Platform sees the event and sends a notification to a Webhook URL you have previously specified. You can get two types of notifications:
- Received messages: This alert lets you know when you have received a message. These can also be called "inbound notifications" throughout the documentation.
- Message status and pricing notifications: This alert lets you know when the status of a message has changed —for example, the message has been read or delivered. These can also be called "outbound notifications" throughout the documentation.
See [Components](https://developers.facebook.com/docs/whatsapp/on-premises/webhooks/components) for information on each field.

### Error Notification
```
{ "errors": [ { "code": <error-code>, "title": "<error-title>", "details": "<error-description>", "href": "location for error detail" }, { ... } ] }
```

## Sample App Endpoints
To test your Webhoooks, you can create a sample app with an endpoint for receiving notifications.
- [Sample App Endpoints using Glitch](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sample-app-endpoints)
[Sample App Endpoints using Glitch](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/sample-app-endpoints)

# On-Premises API Guides
These guides walk through various tasks you can accomplish with the WhatsApp Business On-Premises API.

### [Send Messages](https://developers.facebook.com/docs/whatsapp/guides/messages)
[Send Messages](https://developers.facebook.com/docs/whatsapp/guides/messages)
Use the /messages node to send messages. Learn how to send: [Text Messages](https://developers.facebook.com/docs/whatsapp/api/messages/text), [Media Messages](https://developers.facebook.com/docs/whatsapp/api/messages/media), [Contacts and Location Messages](https://developers.facebook.com/docs/whatsapp/api/messages/contacts-location-messages), [Interactive Messages](https://developers.facebook.com/docs/whatsapp/guides/interactive-messages), [Message Templates](https://developers.facebook.com/docs/whatsapp/message-templates/creation), [Media Message Templates](https://developers.facebook.com/docs/whatsapp/api/messages/message-templates/media-message-templates), [Interactive Message Templates](https://developers.facebook.com/docs/whatsapp/api/messages/message-templates/interactive-message-templates), and [Address Messages](https://developers.facebook.com/docs/whatsapp/api/messages/address-messages).

```
/messages
```

### [Mark Messages as Read](https://developers.facebook.com/docs/whatsapp/guides/mark-as-read)
[Mark Messages as Read](https://developers.facebook.com/docs/whatsapp/guides/mark-as-read)
Use the /messages node to change the status of incoming messages to read.

```
/messages
```


```
read
```

### [Sell Products & Services](https://developers.facebook.com/docs/whatsapp/guides/commerce-guides)
[Sell Products & Services](https://developers.facebook.com/docs/whatsapp/guides/commerce-guides)
Learn how to: [Upload Inventory to Facebook](https://developers.facebook.com/docs/whatsapp/guides/upload-inventory-to-facebook). [Share Products With Customers](https://developers.facebook.com/docs/whatsapp/guides/commerce-guides/share-products-with-customers), and [Receive Responses From Customers](https://developers.facebook.com/docs/whatsapp/guides/commerce-guides/receive-responses-from-customers)

### [Set up and Maintain Your API Client](https://developers.facebook.com/docs/whatsapp/message-templates/creation)
[Set up and Maintain Your API Client](https://developers.facebook.com/docs/whatsapp/message-templates/creation)
Learn how to: [Set up and Debug Your Network](https://developers.facebook.com/docs/whatsapp/guides/network-requirements), [Manage Data and Databases](https://developers.facebook.com/docs/whatsapp/guides/data-management), [Monitor the WhatsApp Business API Client](https://developers.facebook.com/docs/whatsapp/monitoring/instance), [Set Up High Availability](https://developers.facebook.com/docs/whatsapp/high-availability), and [Scale Your API Client With Multiconnect](https://developers.facebook.com/docs/whatsapp/multiconnect_mc). See [High Throughput Recommendations](https://developers.facebook.com/docs/whatsapp/guides/high-throughput)

# WhatsApp Business API Reference
The WhatsApp Business API uses a REST API Architecture with JSON data formats. The API follows the standard HTTP request-response exchange.

## WhatsApp Business API Root Nodes
[Account](https://developers.facebook.com/docs/whatsapp/on-premises/reference/account)

```
Account
```

Register your WhatsApp account
[Certificates](https://developers.facebook.com/docs/whatsapp/on-premises/reference/certificates)

```
Certificates
```

Maintain your Certification Authority (CA) certificates for SSL configuration
[Contacts](https://developers.facebook.com/docs/whatsapp/on-premises/reference/contacts)

```
Contacts
```

Verify customer phone numbers to generate WhatsApp IDs
[Health](https://developers.facebook.com/docs/whatsapp/on-premises/reference/health)

```
Health
```

Check the status of your WhatsApp application
[Media](https://developers.facebook.com/docs/whatsapp/on-premises/reference/media)

```
Media
```

Upload, delete, and retrieve media
[Messages](https://developers.facebook.com/docs/whatsapp/on-premises/reference/messages)

```
Messages
```

Send text, media, message templates, and other types of messages
[Metrics](https://developers.facebook.com/docs/whatsapp/on-premises/reference/metrics)

```
Metrics
```

Collect Webapp metrics
[Services](https://developers.facebook.com/docs/whatsapp/on-premises/reference/services)

```
Services
```

Delete messages from the database
[Settings](https://developers.facebook.com/docs/whatsapp/on-premises/reference/settings)

```
Settings
```

Set your WhatsApp application, profile, and backup and restore settings
[Stats](https://developers.facebook.com/docs/whatsapp/on-premises/reference/stats)

```
Stats
```

Collect Coreapp and database stats
[Stickerpacks](https://developers.facebook.com/docs/whatsapp/on-premises/reference/stickerpacks)

```
Stickerpacks
```

Manage first-party and third-party stickerpacks and stickers
[Support](https://developers.facebook.com/docs/whatsapp/on-premises/reference/support)

```
Support
```

Get help using the WhatsApp Business API
[Users](https://developers.facebook.com/docs/whatsapp/on-premises/reference/users)

```
Users
```

Log in to get your authentication token and manage users

