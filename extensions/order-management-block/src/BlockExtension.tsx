import {
  reactExtension,
  useApi,
  AdminBlock,
  BlockStack,
  Button,
  Text,
  InlineStack,
  Spinner,
} from '@shopify/ui-extensions-react/admin';
import { useState, useEffect } from 'react';

// Цільова сторінка для рендерингу блоку
const TARGET = 'admin.order-details.block.render';

export default reactExtension(TARGET, () => <App />);

function App() {
  const { data, query } = useApi(TARGET);
  const [products, setProducts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);

  // Отримуємо ID замовлення з контексту
  const orderId = data.order.id;

  useEffect(() => {
    async function fetchProductInventory() {
      if (!data.order.lineItems) {
        setIsLoading(false);
        return;
      }

      // Формуємо GraphQL запит для отримання інформації про залишки товарів
      const productVariantIds = data.order.lineItems.map(item => item.variant.id);
      const res = await query<any>(`
        query GetInventoryLevels($variantIds: [ID!]!) {
          productVariants(ids: $variantIds) {
            edges {
              node {
                id
                displayName
                inventoryQuantity
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      `, { variables: { variantIds: productVariantIds } });

      if (res.data) {
        setProducts(res.data.productVariants.edges.map(edge => edge.node));
      }
      setIsLoading(false);
    }

    fetchProductInventory();
  }, [data.order.lineItems, query]);

  const handleProcessOrder = async () => {
    setIsProcessing(true);

    // 1. Додаємо тег до замовлення
    await query(`
      mutation addTags($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          userErrors {
            field
            message
          }
        }
      }
    `, { variables: { id: orderId, tags: ['Списано зі складу'] } });


    // 2. Списуємо товари зі складу
    const inventoryAdjustments = data.order.lineItems.map(item => ({
      inventoryItemId: item.variant.inventoryItem.id,
      availableDelta: -item.quantity, // Від'ємне значення для списання
    }));

    // Отримуємо ID локації. Для простоти беремо першу доступну.
    // В реальному додатку може знадобитись більш складна логіка вибору локації.
    const locationsRes = await query<any>(`{
        locations(first: 1) {
          edges {
            node {
              id
            }
          }
        }
      }`);
    const locationId = locationsRes.data.locations.edges[0].node.id;

    await query(`
      mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          userErrors {
            field
            message
          }
        }
      }
    `, { variables: {
        input: {
          reason: "fulfillment",
          name: "web",
          changes: inventoryAdjustments,
          locationId: locationId
        }
    }});

    setIsProcessing(false);
    // Оновлюємо сторінку для відображення змін
    window.location.reload();
  };


  if (isLoading) {
    return (
      <AdminBlock title="Керування складом">
        <Spinner />
      </AdminBlock>
    );
  }

  return (
    <AdminBlock title="Керування складом">
      <BlockStack>
        <Text fontWeight="bold">Залишки товарів на складі:</Text>
        {products.map(product => (
          <InlineStack key={product.id} blockAlign="center">
            <Text>{product.displayName} - </Text>
            <Text fontWeight="bold">{product.inventoryQuantity} шт.</Text>
          </InlineStack>
        ))}

        <Button
          onPress={handleProcessOrder}
          disabled={isProcessing}
        >
          {isProcessing ? <Spinner /> : 'Додати тег та списати зі складу'}
        </Button>
      </BlockStack>
    </AdminBlock>
  );
}