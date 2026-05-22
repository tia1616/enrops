import React from 'react';
import { Document, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer';

// Presentation PDF for the signed contractor agreement. NOT the legal record
// — that's the server-side snapshot in contractor_agreements.
// agreement_text_snapshot. This PDF mirrors what the user read + adds their
// signature block.
//
// Layout: Times New Roman 11pt body / 14pt headers, letter, 1" margins.

const styles = StyleSheet.create({
  page: {
    padding: 72, // 1 inch
    fontSize: 11,
    fontFamily: 'Times-Roman',
    lineHeight: 1.4,
  },
  header: {
    fontSize: 10,
    color: '#666',
    marginBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
    paddingBottom: 6,
  },
  paragraph: {
    marginBottom: 8,
  },
  signatureBlock: {
    marginTop: 28,
    borderTopWidth: 1,
    borderTopColor: '#000',
    paddingTop: 14,
  },
  signatureLabel: {
    fontSize: 9,
    color: '#666',
    marginBottom: 2,
  },
  signatureValue: {
    fontFamily: 'Times-Italic',
    fontSize: 14,
    marginBottom: 10,
  },
  footer: {
    position: 'absolute',
    bottom: 36,
    left: 72,
    right: 72,
    textAlign: 'center',
    fontSize: 9,
    color: '#999',
  },
});

export function AgreementPdf({ bodyText, typedSignature, signedAt, instructor }) {
  // Split body text on blank lines so paragraph spacing matches the on-screen
  // rendering. Single-line breaks within a paragraph become spaces (React PDF
  // will reflow).
  const paragraphs = (bodyText || '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);

  const dateStr = signedAt
    ? new Date(signedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : new Date().toLocaleDateString();

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.header} fixed>
          Journey to STEAM — Independent Contractor Agreement, Version 2.0
        </Text>

        {paragraphs.map((p, i) => (
          <Text key={i} style={styles.paragraph}>
            {p}
          </Text>
        ))}

        <View style={styles.signatureBlock} wrap={false}>
          <Text style={styles.signatureLabel}>Electronically signed by</Text>
          <Text style={styles.signatureValue}>{typedSignature}</Text>
          <Text style={styles.signatureLabel}>
            Legal name: {(instructor?.first_name || '')} {(instructor?.last_name || '')}
          </Text>
          <Text style={styles.signatureLabel}>Date: {dateStr}</Text>
        </View>

        <Text
          style={styles.footer}
          render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  );
}

export async function renderAgreementPdfBlob(props) {
  const blob = await pdf(<AgreementPdf {...props} />).toBlob();
  return blob;
}
